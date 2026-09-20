require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
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
app.use(express.json({ limit: '15mb' }));

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';
const OWNER_USERNAME = (process.env.OWNER_USERNAME || 'admin').toLowerCase();

const activeSockets = new Map();
const vcMembers = new Map();

function formatPlaytime(totalSeconds) {
    const secondsInMinute = 60;
    const secondsInHour = 3600;
    const secondsInDay = 86400;
    const secondsInMonth = secondsInDay * 30;
    const secondsInYear = secondsInDay * 365;

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

// ================= AUTH ROUTES =================

app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    try {
        const hash = await bcrypt.hash(password, 10);
        const role = username.toLowerCase() === OWNER_USERNAME ? 'owner' : 'member';
        const result = await db.query(
            'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role, avatar_url',
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
            user: { 
                id: user.id, 
                username: user.username, 
                role: user.role, 
                avatar_url: user.avatar_url,
                current_tab: user.current_tab 
            }
        });
    } catch (err) {
        res.status(500).json({ error: 'Login failed' });
    }
});

// ================= AVATAR ROUTES =================

app.post('/api/user/avatar', authenticate, async (req, res) => {
    const { avatarUrl } = req.body;
    try {
        await db.query('UPDATE users SET avatar_url = $1 WHERE id = $2', [avatarUrl, req.user.id]);
        io.emit('friend_avatar_updated', { userId: req.user.id, avatarUrl });
        res.json({ success: true, avatarUrl });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update avatar' });
    }
});

app.post('/api/user/avatar/reset', authenticate, async (req, res) => {
    try {
        await db.query('UPDATE users SET avatar_url = NULL WHERE id = $1', [req.user.id]);
        io.emit('friend_avatar_updated', { userId: req.user.id, avatarUrl: null });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to reset avatar' });
    }
});

// ================= OWNER DEBUG & ADMIN ROUTES =================

app.get('/api/debug', authenticate, async (req, res) => {
    if (req.user.role !== 'owner') {
        return res.status(403).json({ error: 'Access denied. Owner only.' });
    }

    try {
        const result = await db.query(
            'SELECT id, username, role, avatar_url, total_online_seconds, current_tab, tab_started_at FROM users ORDER BY id ASC'
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
                current_tab: user.current_tab
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

app.post('/api/admin/reset-password', authenticate, async (req, res) => {
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
    const { targetUserId, newPassword } = req.body;
    if (!targetUserId || !newPassword) return res.status(400).json({ error: 'Missing parameters' });

    try {
        const hash = await bcrypt.hash(newPassword, 10);
        await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, targetUserId]);
        res.json({ success: true, message: 'Password updated successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to reset password' });
    }
});

app.post('/api/admin/broadcast-alert', authenticate, (req, res) => {
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
    const { alertMessage } = req.body;
    if (alertMessage) {
        io.emit('server_alert', { message: alertMessage, author: req.user.username });
    }
    res.json({ success: true });
});

// ================= ANNOUNCEMENTS =================

app.get('/api/announcements', authenticate, async (req, res) => {
    try {
        const result = await db.query(`
            SELECT a.*, u.avatar_url 
            FROM announcements a 
            LEFT JOIN users u ON u.id = a.user_id 
            ORDER BY a.created_at ASC
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch announcements' });
    }
});

app.post('/api/announcements', authenticate, async (req, res) => {
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only owner can post announcements' });
    const { content } = req.body;
    try {
        const userRes = await db.query('SELECT avatar_url FROM users WHERE id = $1', [req.user.id]);
        const avatarUrl = userRes.rows[0]?.avatar_url || null;

        const result = await db.query(
            'INSERT INTO announcements (user_id, username, avatar_url, content) VALUES ($1, $2, $3, $4) RETURNING *',
            [req.user.id, req.user.username, avatarUrl, content]
        );
        const announcement = result.rows[0];
        io.emit('new_announcement', announcement);
        res.json(announcement);
    } catch (err) {
        res.status(500).json({ error: 'Failed to post announcement' });
    }
});

app.delete('/api/announcements/:id', authenticate, async (req, res) => {
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only owner can delete' });
    try {
        await db.query('DELETE FROM announcements WHERE id = $1', [req.params.id]);
        io.emit('deleted_announcement', req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete' });
    }
});

// ================= GENERAL CHAT =================

app.get('/api/general-messages', authenticate, async (req, res) => {
    try {
        const result = await db.query(`
            SELECT g.*, u.avatar_url 
            FROM general_messages g 
            LEFT JOIN users u ON u.id = g.user_id 
            ORDER BY g.created_at ASC
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch general messages' });
    }
});

app.post('/api/general-messages', authenticate, async (req, res) => {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'Message empty' });
    try {
        const userRes = await db.query('SELECT avatar_url FROM users WHERE id = $1', [req.user.id]);
        const avatarUrl = userRes.rows[0]?.avatar_url || null;

        const result = await db.query(
            'INSERT INTO general_messages (user_id, username, avatar_url, content) VALUES ($1, $2, $3, $4) RETURNING *',
            [req.user.id, req.user.username, avatarUrl, content]
        );
        const msg = result.rows[0];
        io.emit('new_general_message', msg);
        res.json(msg);
    } catch (err) {
        res.status(500).json({ error: 'Failed to post to general' });
    }
});

app.delete('/api/general-messages/:id', authenticate, async (req, res) => {
    try {
        const check = await db.query('SELECT user_id FROM general_messages WHERE id = $1', [req.params.id]);
        if (check.rows.length === 0) return res.status(404).json({ error: 'Message not found' });

        if (check.rows[0].user_id !== req.user.id && req.user.role !== 'owner') {
            return res.status(403).json({ error: 'Cannot delete other user messages' });
        }

        await db.query('DELETE FROM general_messages WHERE id = $1', [req.params.id]);
        io.emit('deleted_general_message', req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete message' });
    }
});

// ================= FRIENDS & DMS =================

app.get('/api/friends', authenticate, async (req, res) => {
    try {
        const result = await db.query(`
            SELECT u.id, u.username, u.role, u.avatar_url, u.current_tab, u.tab_started_at
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
            SELECT m.*, u.avatar_url 
            FROM direct_messages m
            LEFT JOIN users u ON u.id = m.sender_id
            WHERE (m.sender_id = $1 AND m.receiver_id = $2)
               OR (m.sender_id = $2 AND m.receiver_id = $1)
            ORDER BY m.created_at ASC
        `, [req.user.id, req.params.friendId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
});

app.delete('/api/messages/:id', authenticate, async (req, res) => {
    try {
        const check = await db.query('SELECT sender_id, receiver_id FROM direct_messages WHERE id = $1', [req.params.id]);
        if (check.rows.length === 0) return res.status(404).json({ error: 'Message not found' });

        const msg = check.rows[0];
        if (msg.sender_id !== req.user.id && req.user.role !== 'owner') {
            return res.status(403).json({ error: 'Cannot delete this message' });
        }

        await db.query('DELETE FROM direct_messages WHERE id = $1', [req.params.id]);

        const senderSocket = activeSockets.get(msg.sender_id);
        const receiverSocket = activeSockets.get(msg.receiver_id);
        if (senderSocket) io.to(senderSocket.socketId).emit('deleted_dm', req.params.id);
        if (receiverSocket) io.to(receiverSocket.socketId).emit('deleted_dm', req.params.id);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete message' });
    }
});

// ================= SOCKET.IO REALTIME =================

io.on('connection', (socket) => {
    let currentUserId = null;

    socket.on('user_connected', async (userId) => {
        currentUserId = parseInt(userId, 10);
        activeSockets.set(currentUserId, {
            socketId: socket.id,
            connectedAt: Date.now()
        });
        io.emit('user_status_changed', { userId: currentUserId, is_online: true });
        socket.emit('vc_member_list', Array.from(vcMembers.values()));
    });

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

    socket.on('send_dm', async ({ receiverId, content }) => {
        if (!currentUserId) return;
        try {
            const userRes = await db.query('SELECT avatar_url, username FROM users WHERE id = $1', [currentUserId]);
            const senderUser = userRes.rows[0];

            const result = await db.query(
                'INSERT INTO direct_messages (sender_id, receiver_id, content) VALUES ($1, $2, $3) RETURNING *',
                [currentUserId, receiverId, content]
            );
            const message = { 
                ...result.rows[0], 
                avatar_url: senderUser?.avatar_url || null,
                sender_username: senderUser?.username
            };

            socket.emit('receive_dm', message);

            const receiverSocket = activeSockets.get(parseInt(receiverId, 10));
            if (receiverSocket) {
                io.to(receiverSocket.socketId).emit('receive_dm', message);
            }
        } catch (err) {
            console.error('Failed to save message:', err);
        }
    });

    // 1-on-1 Calls
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

    socket.on('renegotiate_offer', ({ targetUserId, offer }) => {
        const target = activeSockets.get(parseInt(targetUserId, 10));
        if (target) {
            io.to(target.socketId).emit('renegotiate_offer', { fromUserId: currentUserId, offer });
        }
    });

    socket.on('renegotiate_answer', ({ targetUserId, answer }) => {
        const target = activeSockets.get(parseInt(targetUserId, 10));
        if (target) {
            io.to(target.socketId).emit('renegotiate_answer', { answer });
        }
    });

    socket.on('end_call', ({ targetUserId }) => {
        const target = activeSockets.get(parseInt(targetUserId, 10));
        if (target) {
            io.to(target.socketId).emit('call_ended');
        }
    });

    // Group VC (Lounge)
    socket.on('join_server_vc', async () => {
        if (!currentUserId) return;
        const userRes = await db.query('SELECT id, username, avatar_url FROM users WHERE id = $1', [currentUserId]);
        const user = userRes.rows[0];
        if (!user) return;

        const memberData = {
            socketId: socket.id,
            userId: user.id,
            username: user.username,
            avatar_url: user.avatar_url
        };

        socket.emit('current_vc_members', Array.from(vcMembers.values()));

        vcMembers.set(socket.id, memberData);
        socket.join('server_lounge');

        socket.to('server_lounge').emit('user_joined_vc', memberData);
        io.emit('vc_member_list', Array.from(vcMembers.values()));
    });

    socket.on('leave_server_vc', () => {
        if (vcMembers.has(socket.id)) {
            const member = vcMembers.get(socket.id);
            vcMembers.delete(socket.id);
            socket.leave('server_lounge');
            socket.to('server_lounge').emit('user_left_vc', { socketId: socket.id, userId: member.userId });
            io.emit('vc_member_list', Array.from(vcMembers.values()));
        }
    });

    socket.on('vc_peer_signal', ({ targetSocketId, signalData }) => {
        io.to(targetSocketId).emit('vc_peer_signal', {
            senderSocketId: socket.id,
            signalData
        });
    });

    socket.on('disconnect', async () => {
        if (vcMembers.has(socket.id)) {
            const member = vcMembers.get(socket.id);
            vcMembers.delete(socket.id);
            socket.to('server_lounge').emit('user_left_vc', { socketId: socket.id, userId: member.userId });
            io.emit('vc_member_list', Array.from(vcMembers.values()));
        }

        if (currentUserId && activeSockets.has(currentUserId)) {
            const session = activeSockets.get(currentUserId);
            const sessionSeconds = Math.floor((Date.now() - session.connectedAt) / 1000);

            await db.query(
                'UPDATE users SET total_online_seconds = total_online_seconds + $1 WHERE id = $2',
                [sessionSeconds, currentUserId]
            );

            activeSockets.delete(currentUserId);
            io.emit('user_status_changed', { userId: currentUserId, is_online: false });
        }
    });
});

app.use(express.static(path.join(__dirname, '../client')));

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/index.html'));
});

server.listen(PORT, () => {
    console.log(`Backend server listening on port ${PORT}`);
});
