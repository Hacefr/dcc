require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';
const OWNER_USERNAME = (process.env.OWNER_USERNAME || 'admin').toLowerCase();

// Store active connections: userId -> { socketId, username, connectedAt }
const activeSockets = new Map();

// Helper: Format total seconds into D/M/Y + Hours/Mins
function formatPlaytime(totalSeconds) {
    const secondsInMinute = 60;
    const secondsInHour = 3600;
    const secondsInDay = 86400;
    const secondsInMonth = secondsInDay * 30; // Approx 30 days
    const secondsInYear = secondsInDay * 365; // Approx 365 days

    const years = Math.floor(totalSeconds / secondsInYear);
    totalSeconds %= secondsInYear;

    const months = Math.floor(totalSeconds / secondsInMonth);
    totalSeconds %= secondsInMonth;

    const days = Math.floor(totalSeconds / secondsInDay);
    totalSeconds %= secondsInDay;

    const hours = Math.floor(totalSeconds / secondsInHour);
    totalSeconds %= secondsInHour;

    const minutes = Math.floor(totalSeconds / secondsInMinute);

    return `${years}y ${months}m ${days}d ${hours}h ${minutes}m`;
}

// Auth Middleware
const authenticate = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });
    const token = authHeader.split(' ')[1];
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        req.user = decoded;
        next();
    });
};

// ================= API ROUTES =================

// 1. Register
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    try {
        const hash = await bcrypt.hash(password, 10);
        const role = username.toLowerCase() === OWNER_USERNAME ? 'owner' : 'member';
        const result = await db.query(
            'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role',
            [username, hash, role]
        );
        const user = result.rows[0];
        const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET);
        res.json({ token, user });
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ error: 'Username already taken' });
        res.status(500).json({ error: 'Registration failed' });
    }
});

// 2. Login
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await db.query('SELECT * FROM users WHERE username = $1', [username]);
        if (result.rows.length === 0) return res.status(400).json({ error: 'User not found' });

        const user = result.rows[0];
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) return res.status(400).json({ error: 'Invalid password' });

        const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET);
        res.json({
            token,
            user: { id: user.id, username: user.username, role: user.role, current_tab: user.current_tab }
        });
    } catch (err) {
        res.status(500).json({ error: 'Login failed' });
    }
});

// 3. DEBUG STATS (All accounts data + playtime in d/m/y)
app.get('/api/debug', async (req, res) => {
    try {
        const result = await db.query(
            'SELECT id, username, role, total_online_seconds, current_tab, tab_started_at FROM users ORDER BY id ASC'
        );

        const now = Date.now();
        const players = result.rows.map(user => {
            const isOnline = activeSockets.has(user.id);
            let currentSessionSeconds = 0;

            if (isOnline) {
                const sessionData = activeSockets.get(user.id);
                currentSessionSeconds = Math.floor((now - sessionData.connectedAt) / 1000);
            }

            const totalSeconds = parseInt(user.total_online_seconds, 10) + currentSessionSeconds;

            return {
                id: user.id,
                username: user.username,
                role: user.role,
                is_online: isOnline,
                playtime_dmy: formatPlaytime(totalSeconds),
                current_tab: user.current_tab,
                tab_started_at: user.tab_started_at
            };
        });

        const today = new Date();
        const dmyDate = `${today.getDate().toString().padStart(2, '0')}/${(today.getMonth() + 1).toString().padStart(2, '0')}/${today.getFullYear()}`;

        res.json({
            system_date: dmyDate,
            total_accounts: players.length,
            online_count: activeSockets.size,
            players
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch debug stats' });
    }
});

// 4. ANNOUNCEMENTS
app.get('/api/announcements', authenticate, async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM announcements ORDER BY created_at ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch announcements' });
    }
});

app.post('/api/announcements', authenticate, async (req, res) => {
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only the owner can post announcements' });
    const { content } = req.body;
    try {
        const result = await db.query(
            'INSERT INTO announcements (user_id, username, content) VALUES ($1, $2, $3) RETURNING *',
            [req.user.id, req.user.username, content]
        );
        const announcement = result.rows[0];
        io.emit('new_announcement', announcement);
        res.json(announcement);
    } catch (err) {
        res.status(500).json({ error: 'Failed to post announcement' });
    }
});

app.delete('/api/announcements/:id', authenticate, async (req, res) => {
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only the owner can delete announcements' });
    try {
        await db.query('DELETE FROM announcements WHERE id = $1', [req.params.id]);
        io.emit('deleted_announcement', req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete announcement' });
    }
});

// 5. FRIENDS & DMs
app.get('/api/friends', authenticate, async (req, res) => {
    try {
        const result = await db.query(`
            SELECT u.id, u.username, u.role, u.current_tab, u.tab_started_at
            FROM users u
            JOIN friendships f ON (f.friend_id = u.id AND f.user_id = $1)
            OR (f.user_id = u.id AND f.friend_id = $1)
            WHERE u.id != $1
        `, [req.user.id]);

        const friends = result.rows.map(f => ({
            ...f,
            is_online: activeSockets.has(f.id)
        }));
        res.json(friends);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch friends' });
    }
});

app.post('/api/friends/add', authenticate, async (req, res) => {
    const { username } = req.body;
    try {
        const targetUser = await db.query('SELECT id FROM users WHERE username = $1', [username]);
        if (targetUser.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        const friendId = targetUser.rows[0].id;
        if (friendId === req.user.id) return res.status(400).json({ error: 'Cannot add yourself' });

        await db.query(
            'INSERT INTO friendships (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [req.user.id, friendId]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to add friend' });
    }
});

app.get('/api/messages/:friendId', authenticate, async (req, res) => {
    try {
        const result = await db.query(`
            SELECT * FROM direct_messages
            WHERE (sender_id = $1 AND receiver_id = $2)
               OR (sender_id = $2 AND receiver_id = $1)
            ORDER BY created_at ASC
        `, [req.user.id, req.params.friendId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
});

// ================= SOCKET.IO REALTIME =================
io.on('connection', (socket) => {
    let currentUserId = null;

    // User Online Authentication
    socket.on('user_connected', async (userId) => {
        currentUserId = parseInt(userId, 10);
        activeSockets.set(currentUserId, {
            socketId: socket.id,
            connectedAt: Date.now()
        });
        io.emit('user_status_changed', { userId: currentUserId, is_online: true });
    });

    // Update active tab status
    socket.on('update_tab_status', async ({ tabName }) => {
        if (!currentUserId) return;
        const startedAt = tabName ? new Date() : null;
        await db.query(
            'UPDATE users SET current_tab = $1, tab_started_at = $2 WHERE id = $3',
            [tabName || 'None', startedAt, currentUserId]
        );
        io.emit('friend_tab_updated', {
            userId: currentUserId,
            current_tab: tabName || 'None',
            tab_started_at: startedAt
        });
    });

    // Realtime Direct Messages
    socket.on('send_dm', async ({ receiverId, content }) => {
        if (!currentUserId) return;
        try {
            const result = await db.query(
                'INSERT INTO direct_messages (sender_id, receiver_id, content) VALUES ($1, $2, $3) RETURNING *',
                [currentUserId, receiverId, content]
            );
            const message = result.rows[0];

            // Send to sender
            socket.emit('receive_dm', message);

            // Send to recipient if online
            const receiverSocket = activeSockets.get(parseInt(receiverId, 10));
            if (receiverSocket) {
                io.to(receiverSocket.socketId).emit('receive_dm', message);
            }
        } catch (err) {
            console.error('Failed to save message:', err);
        }
    });

    // WebRTC Audio Signaling (1-on-1 calls)
    socket.on('call_user', ({ targetUserId, offer }) => {
        const target = activeSockets.get(parseInt(targetUserId, 10));
        if (target) {
            io.to(target.socketId).emit('incoming_call', { fromUserId: currentUserId, offer });
        }
    });

    socket.on('accept_call', ({ targetUserId, answer }) => {
        const target = activeSockets.get(parseInt(targetUserId, 10));
        if (target) {
            io.to(target.socketId).emit('call_accepted', { answer });
        }
    });

    socket.on('ice_candidate', ({ targetUserId, candidate }) => {
        const target = activeSockets.get(parseInt(targetUserId, 10));
        if (target) {
            io.to(target.socketId).emit('ice_candidate', { candidate });
        }
    });

    socket.on('end_call', ({ targetUserId }) => {
        const target = activeSockets.get(parseInt(targetUserId, 10));
        if (target) {
            io.to(target.socketId).emit('call_ended');
        }
    });

    // Handle Disconnect & Record Online Time
    socket.on('disconnect', async () => {
        if (currentUserId && activeSockets.has(currentUserId)) {
            const session = activeSockets.get(currentUserId);
            const sessionSeconds = Math.floor((Date.now() - session.connectedAt) / 1000);

            // Add session seconds to user's database total
            await db.query(
                'UPDATE users SET total_online_seconds = total_online_seconds + $1 WHERE id = $2',
                [sessionSeconds, currentUserId]
            );

            activeSockets.delete(currentUserId);
            io.emit('user_status_changed', { userId: currentUserId, is_online: false });
        }
    });
});

server.listen(PORT, () => {
    console.log(`Backend server listening on port ${PORT}`);
});
