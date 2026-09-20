// Automatically connects to whatever domain the app is running on
const SERVER_URL = window.location.origin;

let token = localStorage.getItem('token');
let currentUser = JSON.parse(localStorage.getItem('user'));
let socket = null;

// App State
let activeView = 'dms'; // 'dms' or 'server'
let activeFriend = null; // Currently opened DM friend object
let friendsList = [];
let localStream = null;
let peerConnection = null;
let tabCaptureStream = null;
let tabTimerInterval = null;

// STUN Configuration for WebRTC
const rtcConfig = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

// ================= DOM ELEMENTS =================
const authOverlay = document.getElementById('auth-overlay');
const loginForm = document.getElementById('login-form');
const signupForm = document.getElementById('signup-form');
const authError = document.getElementById('auth-error');
const signupError = document.getElementById('signup-error');
const appContainer = document.getElementById('app-container');

const navDmsBtn = document.getElementById('nav-dms-btn');
const navServerBtn = document.getElementById('nav-server-btn');
const dmsSection = document.getElementById('dms-sidebar-section');
const serverSection = document.getElementById('server-sidebar-section');
const sidebarTitle = document.getElementById('sidebar-header-title');

const chatHeaderPrefix = document.getElementById('chat-header-prefix');
const chatHeaderTitle = document.getElementById('chat-header-title');
const callHeaderAction = document.getElementById('call-header-action');
const startCallBtn = document.getElementById('start-call-btn');
const activeCallPanel = document.getElementById('active-call-panel');
const callStatusText = document.getElementById('call-status-text');
const muteMicBtn = document.getElementById('mute-mic-btn');
const endCallBtn = document.getElementById('end-call-btn');
const remoteAudio = document.getElementById('remote-audio');

const messagesContainer = document.getElementById('messages-container');
const chatForm = document.getElementById('chat-message-form');
const chatInput = document.getElementById('chat-message-input');
const channelLockedBanner = document.getElementById('channel-locked-banner');

const debugOverlay = document.getElementById('debug-overlay');
const closeDebugBtn = document.getElementById('close-debug-btn');

// ================= 1. ROUTING & DEBUG VIEW =================
function handleRoute() {
    if (window.location.hash === '#debug') {
        openDebugView();
    } else {
        debugOverlay.style.display = 'none';
    }
}

window.addEventListener('hashchange', handleRoute);
closeDebugBtn.addEventListener('click', () => {
    window.location.hash = '';
});

async function openDebugView() {
    debugOverlay.style.display = 'flex';
    try {
        const res = await fetch(`${SERVER_URL}/api/debug`);
        const data = await res.json();

        document.getElementById('debug-sys-date').innerText = `System Date: ${data.system_date}`;
        document.getElementById('debug-total-accounts').innerText = `Total Accounts: ${data.total_accounts}`;
        document.getElementById('debug-online-now').innerText = `Online Right Now: ${data.online_count}`;

        const tbody = document.getElementById('debug-players-body');
        tbody.innerHTML = '';

        data.players.forEach(p => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${p.username}</strong></td>
                <td><span class="${p.role === 'owner' ? 'author-tag' : ''}">${p.role}</span></td>
                <td><span class="${p.is_online ? 'status-online' : 'status-offline'}">${p.is_online ? 'Online' : 'Offline'}</span></td>
                <td>${p.playtime_dmy}</td>
                <td>${p.current_tab}</td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        console.error('Failed to load debug data', err);
    }
}

// ================= 2. AUTHENTICATION =================
document.getElementById('to-signup').addEventListener('click', () => {
    loginForm.style.display = 'none';
    signupForm.style.display = 'block';
});
document.getElementById('to-login').addEventListener('click', () => {
    signupForm.style.display = 'none';
    loginForm.style.display = 'block';
});

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    authError.innerText = '';
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;

    try {
        const res = await fetch(`${SERVER_URL}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        saveAuth(data.token, data.user);
    } catch (err) {
        authError.innerText = err.message;
    }
});

signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    signupError.innerText = '';
    const username = document.getElementById('signup-username').value;
    const password = document.getElementById('signup-password').value;

    try {
        const res = await fetch(`${SERVER_URL}/api/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        saveAuth(data.token, data.user);
    } catch (err) {
        signupError.innerText = err.message;
    }
});

function saveAuth(newToken, newUser) {
    token = newToken;
    currentUser = newUser;
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(currentUser));
    initApp();
}

function initApp() {
    if (!token || !currentUser) {
        authOverlay.style.display = 'flex';
        appContainer.style.display = 'none';
        return;
    }
    authOverlay.style.display = 'none';
    appContainer.style.display = 'flex';

    document.getElementById('my-username-display').innerText = currentUser.username;
    document.getElementById('my-avatar-text').innerText = currentUser.username[0].toUpperCase();

    initSocket();
    loadFriends();
    handleRoute();
}

// ================= 3. SOCKET & REALTIME =================
function initSocket() {
    socket = io(SERVER_URL);

    socket.on('connect', () => {
        socket.emit('user_connected', currentUser.id);
    });

    socket.on('user_status_changed', ({ userId, is_online }) => {
        const friend = friendsList.find(f => f.id === userId);
        if (friend) {
            friend.is_online = is_online;
            renderFriendsList();
        }
    });

    socket.on('friend_tab_updated', ({ userId, current_tab }) => {
        const friend = friendsList.find(f => f.id === userId);
        if (friend) {
            friend.current_tab = current_tab;
            renderFriendsList();
        }
    });

    socket.on('receive_dm', (message) => {
        if (activeView === 'dms' && activeFriend && 
           (message.sender_id === activeFriend.id || message.sender_id === currentUser.id)) {
            appendMessage(message.sender_id === currentUser.id ? currentUser.username : activeFriend.username, message.content, message.created_at);
        }
    });

    socket.on('new_announcement', (announcement) => {
        if (activeView === 'server') {
            appendAnnouncement(announcement);
        }
    });

    socket.on('deleted_announcement', (id) => {
        const el = document.getElementById(`announcement-${id}`);
        if (el) el.remove();
    });

    // WebRTC Signaling Events
    socket.on('incoming_call', async ({ fromUserId, offer }) => {
        const friend = friendsList.find(f => f.id === fromUserId);
        const callerName = friend ? friend.username : 'Friend';
        if (confirm(`Incoming voice call from ${callerName}. Accept?`)) {
            activeFriend = friend;
            await setupPeerConnection();
            await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            socket.emit('accept_call', { targetUserId: fromUserId, answer });
            activeCallPanel.style.display = 'flex';
            callStatusText.innerText = `Connected with ${callerName}`;
        }
    });

    socket.on('call_accepted', async ({ answer }) => {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        callStatusText.innerText = `Connected with ${activeFriend.username}`;
    });

    socket.on('ice_candidate', async ({ candidate }) => {
        if (peerConnection && candidate) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        }
    });

    socket.on('call_ended', () => {
        endCallCleanly();
    });
}

// ================= 4. NAVIGATION (DMs vs SERVER) =================
navDmsBtn.addEventListener('click', () => {
    activeView = 'dms';
    navDmsBtn.classList.add('active');
    navServerBtn.classList.remove('active');
    dmsSection.style.display = 'block';
    serverSection.style.display = 'none';
    sidebarTitle.innerText = 'Direct Messages';
    channelLockedBanner.style.display = 'none';
    chatForm.style.display = 'flex';

    if (activeFriend) openDM(activeFriend);
    else {
        chatHeaderPrefix.innerText = '@';
        chatHeaderTitle.innerText = 'Select a friend';
        callHeaderAction.style.display = 'none';
        messagesContainer.innerHTML = '';
    }
});

navServerBtn.addEventListener('click', () => {
    activeView = 'server';
    navServerBtn.classList.add('active');
    navDmsBtn.classList.remove('active');
    dmsSection.style.display = 'none';
    serverSection.style.display = 'block';
    sidebarTitle.innerText = 'The Server';
    callHeaderAction.style.display = 'none';
    openAnnouncements();
});

// ================= 5. ANNOUNCEMENTS =================
async function openAnnouncements() {
    chatHeaderPrefix.innerText = '#';
    chatHeaderTitle.innerText = 'announcements';
    messagesContainer.innerHTML = '';

    if (currentUser.role === 'owner') {
        channelLockedBanner.style.display = 'none';
        chatForm.style.display = 'flex';
        chatInput.placeholder = 'Post announcement as Owner...';
    } else {
        chatForm.style.display = 'none';
        channelLockedBanner.style.display = 'block';
    }

    try {
        const res = await fetch(`${SERVER_URL}/api/announcements`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const announcements = await res.json();
        announcements.forEach(appendAnnouncement);
    } catch (err) {
        console.error(err);
    }
}

function appendAnnouncement(item) {
    const msg = document.createElement('div');
    msg.className = 'message';
    msg.id = `announcement-${item.id}`;

    const date = new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const deleteBtnHtml = currentUser.role === 'owner' 
        ? `<button class="delete-btn" onclick="deleteAnnouncement(${item.id})">Delete</button>` 
        : '';

    msg.innerHTML = `
        <div class="avatar-placeholder">${item.username[0].toUpperCase()}</div>
        <div class="message-content">
            <div class="message-header">
                <span class="message-author">${item.username}</span>
                <span class="author-tag">Owner</span>
                <span class="message-time">${date}</span>
                ${deleteBtnHtml}
            </div>
            <p class="message-body">${item.content}</p>
        </div>
    `;
    messagesContainer.appendChild(msg);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

window.deleteAnnouncement = async function(id) {
    await fetch(`${SERVER_URL}/api/announcements/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
    });
};

// ================= 6. FRIENDS & DMs =================
async function loadFriends() {
    try {
        const res = await fetch(`${SERVER_URL}/api/friends`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        friendsList = await res.json();
        renderFriendsList();
    } catch (err) {
        console.error(err);
    }
}

function renderFriendsList() {
    const list = document.getElementById('friends-list');
    list.innerHTML = '';

    friendsList.forEach(friend => {
        const li = document.createElement('li');
        li.className = `friend-item ${activeFriend && activeFriend.id === friend.id ? 'active' : ''}`;
        li.onclick = () => openDM(friend);

        const activity = friend.is_online 
            ? (friend.current_tab !== 'None' ? friend.current_tab : 'Online')
            : 'Offline';

        li.innerHTML = `
            <div class="avatar-wrapper">
                <div class="avatar-placeholder">${friend.username[0].toUpperCase()}</div>
                <span class="status-indicator ${friend.is_online ? 'online' : 'offline'}"></span>
            </div>
            <div class="friend-info">
                <span class="friend-name">${friend.username}</span>
                <span class="friend-activity ${!friend.is_online ? 'offline-text' : ''}">${activity}</span>
            </div>
        `;
        list.appendChild(li);
    });
}

document.getElementById('add-friend-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('add-friend-input');
    const username = input.value.trim();
    if (!username) return;

    try {
        const res = await fetch(`${SERVER_URL}/api/friends/add`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ username })
        });
        if (res.ok) {
            input.value = '';
            loadFriends();
        } else {
            const data = await res.json();
            alert(data.error || 'Failed to add friend');
        }
    } catch (err) {
        console.error(err);
    }
});

async function openDM(friend) {
    activeFriend = friend;
    renderFriendsList();

    chatHeaderPrefix.innerText = '@';
    chatHeaderTitle.innerText = friend.username;
    callHeaderAction.style.display = 'block';
    chatInput.placeholder = `Message @${friend.username}...`;
    messagesContainer.innerHTML = '';

    try {
        const res = await fetch(`${SERVER_URL}/api/messages/${friend.id}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const messages = await res.json();
        messages.forEach(m => {
            appendMessage(m.sender_id === currentUser.id ? currentUser.username : friend.username, m.content, m.created_at);
        });
    } catch (err) {
        console.error(err);
    }
}

chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;

    if (activeView === 'server') {
        await fetch(`${SERVER_URL}/api/announcements`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ content: text })
        });
    } else if (activeView === 'dms' && activeFriend) {
        socket.emit('send_dm', { receiverId: activeFriend.id, content: text });
    }

    chatInput.value = '';
});

function appendMessage(author, text, createdAt) {
    const msg = document.createElement('div');
    msg.className = 'message';
    const date = new Date(createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    msg.innerHTML = `
        <div class="avatar-placeholder">${author[0].toUpperCase()}</div>
        <div class="message-content">
            <div class="message-header">
                <span class="message-author">${author}</span>
                <span class="message-time">${date}</span>
            </div>
            <p class="message-body">${text}</p>
        </div>
    `;
    messagesContainer.appendChild(msg);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// ================= 7. WEBRTC AUDIO CALLING =================
async function setupPeerConnection() {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    peerConnection = new RTCPeerConnection(rtcConfig);

    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    peerConnection.ontrack = (event) => {
        remoteAudio.srcObject = event.streams[0];
    };

    peerConnection.onicecandidate = (event) => {
        if (event.candidate && activeFriend) {
            socket.emit('ice_candidate', { targetUserId: activeFriend.id, candidate: event.candidate });
        }
    };
}

startCallBtn.addEventListener('click', async () => {
    if (!activeFriend) return;
    await setupPeerConnection();
    activeCallPanel.style.display = 'flex';
    callStatusText.innerText = `Calling ${activeFriend.username}...`;

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('call_user', { targetUserId: activeFriend.id, offer });
});

muteMicBtn.addEventListener('click', () => {
    if (localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        audioTrack.enabled = !audioTrack.enabled;
        muteMicBtn.innerText = audioTrack.enabled ? 'Mute' : 'Unmute';
    }
});

endCallBtn.addEventListener('click', () => {
    if (activeFriend) {
        socket.emit('end_call', { targetUserId: activeFriend.id });
    }
    endCallCleanly();
});

function endCallCleanly() {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    activeCallPanel.style.display = 'none';
}

// ================= 8. TAB TRACKER & TIMER =================
const trackTabBtn = document.getElementById('track-tab-btn');
const clearTabBtn = document.getElementById('clear-tab-btn');
const myStatusText = document.getElementById('my-status-text');

trackTabBtn.addEventListener('click', async () => {
    try {
        tabCaptureStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        const track = tabCaptureStream.getVideoTracks()[0];
        const tabTitle = track.label || 'Active Tab';

        track.stop();

        startActivityTimer(tabTitle);
        socket.emit('update_tab_status', { tabName: tabTitle });
    } catch (err) {
        console.log('Tab selection cancelled.');
    }
});

clearTabBtn.addEventListener('click', () => {
    clearInterval(tabTimerInterval);
    myStatusText.innerText = 'Tracking: Nothing';
    socket.emit('update_tab_status', { tabName: 'None' });
});

function startActivityTimer(tabTitle) {
    clearInterval(tabTimerInterval);
    let seconds = 0;

    tabTimerInterval = setInterval(() => {
        seconds++;
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        const timeFormatted = `${mins}m ${secs}s`;
        myStatusText.innerText = `${tabTitle} (${timeFormatted})`;
    }, 1000);
}

// Start app
initApp();
