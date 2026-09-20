const SERVER_URL = window.location.origin;

if (typeof marked !== 'undefined') {
    marked.setOptions({ breaks: true, gfm: true });
}

let token = localStorage.getItem('token');
let currentUser = JSON.parse(localStorage.getItem('user'));
let socket = null;

// App State (Restored from localStorage)
let activeView = localStorage.getItem('last_view') || 'dms'; 
let activeChannel = localStorage.getItem('last_channel') || 'announcements';
let activeFriend = null;
let friendsList = [];

// 1-on-1 Call State
let localStream = null;
let screenStream = null;
let peerConnection = null;
let isCallDeafened = false;

// Group VC (Lounge) State
let inLoungeVC = false;
let vcLocalAudioStream = null;
let vcLocalScreenStream = null;
let vcPeers = new Map(); // socketId -> RTCPeerConnection
let vcMembersList = [];
let isLoungeDeafened = false;

// Tab Tracker
let tabCaptureStream = null;
let tabTimerInterval = null;

// Speaking Detection
let audioContext = null;
let analyser = null;
let speakingInterval = null;

const rtcConfig = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

const emojis = [
    '😀','😃','😄','😁','😆','😅','😂','🤣','🙂','🙃','😉','😊',
    '😇','😍','🤩','😘','😋','😛','😜','🤪','😎','🤓','🧐','🥳',
    '😏','😒','😞','😢','😭','😤','😠','😡','🤬','🤯','😳','🥶',
    '😱','😨','😰','🤔','🤫','🤭','😴','💀','☠️','👻','🤡','💩',
    '👋','👌','✌️','🤞','🤟','🤙','👍','👎','👏','🙌','🤝','🔥',
    '✨','🎉','💯','❤️','💔','🎮','💻','🚀','👀','🍕','🍔','☕'
];

// ================= NATIVE AUDIO CHIMES SYNTHESIZER =================
function playChime(type) {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.connect(gain);
        gain.connect(ctx.destination);

        const now = ctx.currentTime;

        if (type === 'join') {
            osc.frequency.setValueAtTime(440, now);
            osc.frequency.exponentialRampToValueAtTime(880, now + 0.15);
            gain.gain.setValueAtTime(0.12, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
            osc.start(now);
            osc.stop(now + 0.25);
        } else if (type === 'leave') {
            osc.frequency.setValueAtTime(880, now);
            osc.frequency.exponentialRampToValueAtTime(440, now + 0.15);
            gain.gain.setValueAtTime(0.12, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
            osc.start(now);
            osc.stop(now + 0.25);
        } else if (type === 'message') {
            osc.frequency.setValueAtTime(587.33, now);
            gain.gain.setValueAtTime(0.08, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
            osc.start(now);
            osc.stop(now + 0.12);
        } else if (type === 'mention') {
            osc.frequency.setValueAtTime(659.25, now);
            osc.frequency.setValueAtTime(880, now + 0.1);
            gain.gain.setValueAtTime(0.15, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
            osc.start(now);
            osc.stop(now + 0.3);
        }
    } catch (e) { /* AudioContext requires user gesture first */ }
}

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

const channelAnnounceBtn = document.getElementById('channel-announcements-btn');
const channelGeneralBtn = document.getElementById('channel-general-btn');
const channelVcBtn = document.getElementById('channel-vc-btn');
const vcOccupantsList = document.getElementById('vc-occupants-list');

const vcConnectedDock = document.getElementById('vc-connected-dock');
const dockScreenBtn = document.getElementById('dock-screen-btn');
const dockMuteBtn = document.getElementById('dock-mute-btn');
const dockDeafenBtn = document.getElementById('dock-deafen-btn');
const dockDisconnectBtn = document.getElementById('dock-disconnect-btn');

const vcStageArea = document.getElementById('vc-stage-area');
const vcScreenContainer = document.getElementById('vc-screen-container');
const vcScreenVideo = document.getElementById('vc-screen-video');
const vcParticipantsGrid = document.getElementById('vc-participants-grid');
const vcAudioPool = document.getElementById('vc-audio-pool');

const chatHeaderPrefix = document.getElementById('chat-header-prefix');
const chatHeaderTitle = document.getElementById('chat-header-title');
const callHeaderAction = document.getElementById('call-header-action');
const startCallBtn = document.getElementById('start-call-btn');
const activeCallPanel = document.getElementById('active-call-panel');
const callStatusText = document.getElementById('call-status-text');
const screenShareBtn = document.getElementById('screen-share-btn');
const muteMicBtn = document.getElementById('mute-mic-btn');
const deafenCallBtn = document.getElementById('deafen-call-btn');
const endCallBtn = document.getElementById('end-call-btn');
const remoteAudio = document.getElementById('remote-audio');
const remoteVideo = document.getElementById('remote-video');

const messagesContainer = document.getElementById('messages-container');
const chatInputContainer = document.getElementById('chat-input-container');
const chatForm = document.getElementById('chat-message-form');
const chatInput = document.getElementById('chat-message-input');
const channelLockedBanner = document.getElementById('channel-locked-banner');

const debugOverlay = document.getElementById('debug-overlay');
const closeDebugBtn = document.getElementById('close-debug-btn');
const broadcastInput = document.getElementById('broadcast-input');
const sendBroadcastBtn = document.getElementById('send-broadcast-btn');
const serverAlertBanner = document.getElementById('server-alert-banner');
const alertBannerText = document.getElementById('alert-banner-text');

const avatarFileInput = document.getElementById('avatar-file-input');
const myAvatarBtn = document.getElementById('my-avatar-btn');
const myAvatarImg = document.getElementById('my-avatar-img');
const myAvatarText = document.getElementById('my-avatar-text');
const resetPfpBtn = document.getElementById('reset-pfp-btn');
const logoutBtn = document.getElementById('logout-btn');

const emojiPicker = document.getElementById('emoji-picker');
const emojiToggleBtn = document.getElementById('emoji-toggle-btn');

function createAvatarElement(username, avatarUrl, id = '') {
    const idAttr = id ? `id="avatar-${id}"` : '';
    if (avatarUrl) {
        return `<img src="${avatarUrl}" class="avatar" ${idAttr} alt="${username}">`;
    }
    return `<div class="avatar-placeholder" ${idAttr}>${username[0].toUpperCase()}</div>`;
}

function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
}

function sendDesktopNotification(title, body) {
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
        new Notification(title, { body, icon: 'icon.png' });
    }
}

// Emoji Picker Setup
emojis.forEach(e => {
    const span = document.createElement('span');
    span.className = 'emoji-item';
    span.innerText = e;
    span.onclick = () => {
        chatInput.value += e;
        chatInput.focus();
    };
    emojiPicker.appendChild(span);
});

emojiToggleBtn.onclick = (ev) => {
    ev.stopPropagation();
    emojiPicker.style.display = emojiPicker.style.display === 'none' ? 'grid' : 'none';
};

document.addEventListener('click', (ev) => {
    if (!emojiPicker.contains(ev.target) && ev.target !== emojiToggleBtn) {
        emojiPicker.style.display = 'none';
    }
});

// Double-click Fullscreen for Screen Sharing
vcScreenVideo.ondblclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (vcScreenVideo.srcObject) vcScreenVideo.requestFullscreen();
};
remoteVideo.ondblclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (remoteVideo.srcObject) remoteVideo.requestFullscreen();
};

// Clipboard Screenshot Pasting (Ctrl + V)
chatInput.addEventListener('paste', (e) => {
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (let item of items) {
        if (item.type.indexOf('image') !== -1) {
            e.preventDefault();
            const blob = item.getAsFile();
            const reader = new FileReader();
            reader.onload = (event) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    const maxDim = 600;
                    let w = img.width, h = img.height;
                    if (w > maxDim || h > maxDim) {
                        if (w > h) { h = Math.round((h * maxDim) / w); w = maxDim; }
                        else { w = Math.round((w * maxDim) / h); h = maxDim; }
                    }
                    canvas.width = w; canvas.height = h;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, w, h);
                    const base64 = canvas.toDataURL('image/jpeg', 0.8);
                    
                    chatInput.value += `\n![screenshot](${base64})\n`;
                };
                img.src = event.target.result;
            };
            reader.readAsDataURL(blob);
            break;
        }
    }
});

// ================= 1. ROUTING & DEBUG VIEW (OWNER ONLY) =================
function handleRoute() {
    if (window.location.hash === '#debug') {
        if (!currentUser || currentUser.role !== 'owner') {
            alert('Access Denied: The debug console is restricted to the Owner.');
            window.location.hash = '';
            return;
        }
        openDebugView();
    } else {
        debugOverlay.style.display = 'none';
    }
}

window.addEventListener('hashchange', handleRoute);
closeDebugBtn.addEventListener('click', () => { window.location.hash = ''; });

async function openDebugView() {
    debugOverlay.style.display = 'flex';
    try {
        const res = await fetch(`${SERVER_URL}/api/debug`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('Forbidden');
        const data = await res.json();

        document.getElementById('debug-sys-date').innerText = `System Date: ${data.system_date}`;
        document.getElementById('debug-total-accounts').innerText = `Total Accounts: ${data.total_accounts}`;
        document.getElementById('debug-online-now').innerText = `Online Right Now: ${data.online_count}`;

        const tbody = document.getElementById('debug-players-body');
        tbody.innerHTML = '';

        data.players.forEach(p => {
            const tr = document.createElement('tr');
            const resetBtn = p.role !== 'owner' 
                ? `<button class="btn-reset-pw" onclick="resetUserPassword(${p.id}, '${p.username}')">Reset PW</button>`
                : '';

            tr.innerHTML = `
                <td><strong>${p.username}</strong></td>
                <td><span class="${p.role === 'owner' ? 'author-tag' : ''}">${p.role}</span></td>
                <td><span class="${p.is_online ? 'status-online' : 'status-offline'}">${p.is_online ? 'Online' : 'Offline'}</span></td>
                <td>${p.playtime_dmy}</td>
                <td>${p.current_tab}</td>
                <td>${resetBtn}</td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        alert('Failed to load debug statistics: ' + err.message);
        window.location.hash = '';
    }
}

window.resetUserPassword = async function(targetUserId, username) {
    const newPassword = prompt(`Enter new password for ${username}:`);
    if (!newPassword) return;

    const res = await fetch(`${SERVER_URL}/api/admin/reset-password`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ targetUserId, newPassword })
    });
    const data = await res.json();
    alert(data.message || data.error);
};

sendBroadcastBtn.onclick = async () => {
    const alertMessage = broadcastInput.value.trim();
    if (!alertMessage) return;
    await fetch(`${SERVER_URL}/api/admin/broadcast-alert`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ alertMessage })
    });
    broadcastInput.value = '';
    alert('Alert broadcasted to all online users.');
};

// ================= 2. AUTHENTICATION & LOGOUT =================
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

logoutBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to log out?')) {
        leaveLoungeVC();
        endCallCleanly();

        if (socket) {
            socket.disconnect();
            socket = null;
        }

        localStorage.clear();
        token = null;
        currentUser = null;

        appContainer.style.display = 'none';
        authOverlay.style.display = 'flex';
        loginForm.style.display = 'block';
        signupForm.style.display = 'none';
        document.getElementById('login-username').value = '';
        document.getElementById('login-password').value = '';
    }
});

function updateMyAvatarDisplay(url) {
    if (url) {
        myAvatarImg.src = url;
        myAvatarImg.style.display = 'block';
        myAvatarText.style.display = 'none';
    } else {
        myAvatarImg.style.display = 'none';
        myAvatarText.style.display = 'flex';
        myAvatarText.innerText = currentUser ? currentUser.username[0].toUpperCase() : 'U';
    }
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
    updateMyAvatarDisplay(currentUser.avatar_url);

    requestNotificationPermission();
    initSocket();
    loadFriends();

    // Restore last channel/view
    if (activeView === 'server') {
        navServerBtn.click();
        if (activeChannel === 'general') channelGeneralBtn.click();
        else channelAnnounceBtn.click();
    } else {
        navDmsBtn.click();
    }

    handleRoute();
}

// ================= 3. PROFILE PICTURE & RESET PFP =================
myAvatarBtn.addEventListener('click', () => { avatarFileInput.click(); });

avatarFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        const img = new Image();
        img.onload = async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 96; canvas.height = 96;
            const ctx = canvas.getContext('2d');

            const minSide = Math.min(img.width, img.height);
            const startX = (img.width - minSide) / 2;
            const startY = (img.height - minSide) / 2;

            ctx.drawImage(img, startX, startY, minSide, minSide, 0, 0, 96, 96);
            const base64Image = canvas.toDataURL('image/jpeg', 0.85);

            currentUser.avatar_url = base64Image;
            localStorage.setItem('user', JSON.stringify(currentUser));
            updateMyAvatarDisplay(base64Image);

            try {
                await fetch(`${SERVER_URL}/api/user/avatar`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({ avatarUrl: base64Image })
                });
            } catch (err) { console.error(err); }
        };
        img.src = event.target.result;
    };
    reader.readAsDataURL(file);
});

resetPfpBtn.addEventListener('click', async () => {
    if (!confirm('Reset your profile picture across all devices?')) return;
    try {
        await fetch(`${SERVER_URL}/api/user/avatar/reset`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });

        currentUser.avatar_url = null;
        localStorage.setItem('user', JSON.stringify(currentUser));
        localStorage.removeItem('my_local_avatar');
        updateMyAvatarDisplay(null);
        alert('Profile picture reset.');
    } catch (err) { alert('Failed to reset avatar.'); }
});

// ================= 4. SOCKET & REALTIME =================
function initSocket() {
    socket = io(SERVER_URL);

    socket.on('connect', () => {
        socket.emit('user_connected', currentUser.id);
    });

    socket.on('server_alert', ({ message, author }) => {
        alertBannerText.innerText = `[Announcement from ${author}]: ${message}`;
        serverAlertBanner.style.display = 'flex';
        playChime('mention');
    });

    socket.on('user_status_changed', ({ userId, is_online }) => {
        const friend = friendsList.find(f => f.id === userId);
        if (friend) {
            friend.is_online = is_online;
            renderFriendsList();
        }
    });

    socket.on('friend_avatar_updated', ({ userId, avatarUrl }) => {
        if (currentUser && currentUser.id === userId) {
            currentUser.avatar_url = avatarUrl;
            localStorage.setItem('user', JSON.stringify(currentUser));
            updateMyAvatarDisplay(avatarUrl);
        }
        const friend = friendsList.find(f => f.id === userId);
        if (friend) {
            friend.avatar_url = avatarUrl;
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
        const isMe = message.sender_id === currentUser.id;
        const isMentioned = message.content.includes(`@${currentUser.username}`);

        if (activeView === 'dms' && activeFriend && 
           (message.sender_id === activeFriend.id || isMe)) {
            const author = isMe ? currentUser.username : activeFriend.username;
            appendMessage(author, message.content, message.created_at, message.avatar_url, message.id, isMe);
            if (!isMe) playChime(isMentioned ? 'mention' : 'message');
        } else if (!isMe) {
            playChime(isMentioned ? 'mention' : 'message');
            sendDesktopNotification(`New message from ${message.sender_username || 'Friend'}`, message.content);
        }
    });

    socket.on('deleted_dm', (id) => {
        const el = document.getElementById(`msg-${id}`);
        if (el) el.remove();
    });

    socket.on('new_announcement', (announcement) => {
        if (activeView === 'server' && activeChannel === 'announcements') {
            appendAnnouncement(announcement);
        }
        playChime('message');
    });

    socket.on('deleted_announcement', (id) => {
        const el = document.getElementById(`announcement-${id}`);
        if (el) el.remove();
    });

    socket.on('new_general_message', (msg) => {
        const isMe = msg.user_id === currentUser.id;
        const isMentioned = msg.content.includes(`@${currentUser.username}`);

        if (activeView === 'server' && activeChannel === 'general') {
            appendGeneralMessage(msg);
            if (!isMe) playChime(isMentioned ? 'mention' : 'message');
        } else if (!isMe) {
            if (isMentioned) {
                playChime('mention');
                sendDesktopNotification('Mentioned in #general', `${msg.username}: ${msg.content}`);
            }
        }
    });

    socket.on('deleted_general_message', (id) => {
        const el = document.getElementById(`gen-msg-${id}`);
        if (el) el.remove();
    });

    // 1-on-1 Calls
    socket.on('incoming_call', async ({ fromUserId, offer }) => {
        const friend = friendsList.find(f => f.id === fromUserId);
        const callerName = friend ? friend.username : 'Friend';
        playChime('mention');
        sendDesktopNotification('Incoming Call', `${callerName} is calling you!`);

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

    socket.on('renegotiate_offer', async ({ fromUserId, offer }) => {
        if (peerConnection) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            socket.emit('renegotiate_answer', { targetUserId: fromUserId, answer });
        }
    });

    socket.on('renegotiate_answer', async ({ answer }) => {
        if (peerConnection) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        }
    });

    socket.on('call_ended', () => { endCallCleanly(); });

    // Group VC (Lounge)
    socket.on('vc_member_list', (members) => {
        vcMembersList = members;
        renderVcOccupantsTree();
        if (inLoungeVC) renderVcStageGrid();
    });

    socket.on('current_vc_members', async (existingMembers) => {
        for (const peer of existingMembers) {
            await createVcPeerConnection(peer.socketId, true);
        }
    });

    socket.on('user_joined_vc', async (newMember) => {
        playChime('join');
        await createVcPeerConnection(newMember.socketId, false);
    });

    socket.on('vc_peer_signal', async ({ senderSocketId, signalData }) => {
        let pc = vcPeers.get(senderSocketId);
        if (!pc) {
            pc = await createVcPeerConnection(senderSocketId, false);
        }

        if (signalData.type === 'offer') {
            await pc.setRemoteDescription(new RTCSessionDescription(signalData));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.emit('vc_peer_signal', { targetSocketId: senderSocketId, signalData: answer });
        } else if (signalData.type === 'answer') {
            await pc.setRemoteDescription(new RTCSessionDescription(signalData));
        } else if (signalData.candidate) {
            await pc.addIceCandidate(new RTCIceCandidate(signalData.candidate));
        }
    });

    socket.on('user_left_vc', ({ socketId }) => {
        playChime('leave');
        if (vcPeers.has(socketId)) {
            vcPeers.get(socketId).close();
            vcPeers.delete(socketId);
        }
        const audioEl = document.getElementById(`vc-audio-${socketId}`);
        if (audioEl) audioEl.remove();
    });
}

// ================= 5. NAVIGATION =================
navDmsBtn.addEventListener('click', () => {
    activeView = 'dms';
    localStorage.setItem('last_view', 'dms');
    navDmsBtn.classList.add('active');
    navServerBtn.classList.remove('active');
    dmsSection.style.display = 'block';
    serverSection.style.display = 'none';
    sidebarTitle.innerText = 'Direct Messages';
    channelLockedBanner.style.display = 'none';
    chatForm.style.display = 'flex';
    vcStageArea.style.display = 'none';
    messagesContainer.style.display = 'flex';
    chatInputContainer.style.display = 'block';

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
    localStorage.setItem('last_view', 'server');
    navServerBtn.classList.add('active');
    navDmsBtn.classList.remove('active');
    dmsSection.style.display = 'none';
    serverSection.style.display = 'block';
    sidebarTitle.innerText = 'The Server';
    callHeaderAction.style.display = 'none';
    openServerChannel(activeChannel);
});

channelAnnounceBtn.addEventListener('click', () => {
    channelAnnounceBtn.classList.add('active');
    channelGeneralBtn.classList.remove('active');
    channelVcBtn.classList.remove('active');
    openServerChannel('announcements');
});

channelGeneralBtn.addEventListener('click', () => {
    channelGeneralBtn.classList.add('active');
    channelAnnounceBtn.classList.remove('active');
    channelVcBtn.classList.remove('active');
    openServerChannel('general');
});

channelVcBtn.addEventListener('click', () => {
    channelVcBtn.classList.add('active');
    channelAnnounceBtn.classList.remove('active');
    channelGeneralBtn.classList.remove('active');
    openServerChannel('vc');
    if (!inLoungeVC) joinLoungeVC();
});

function openServerChannel(channel) {
    activeChannel = channel;
    localStorage.setItem('last_channel', channel);

    if (channel === 'vc') {
        chatHeaderPrefix.innerText = '🔊';
        chatHeaderTitle.innerText = 'Lounge';
        messagesContainer.style.display = 'none';
        chatInputContainer.style.display = 'none';
        vcStageArea.style.display = 'flex';
        renderVcStageGrid();
        return;
    }

    vcStageArea.style.display = 'none';
    messagesContainer.style.display = 'flex';
    chatInputContainer.style.display = 'block';
    messagesContainer.innerHTML = '';
    chatHeaderPrefix.innerText = '#';
    chatHeaderTitle.innerText = channel;

    if (channel === 'announcements') {
        if (currentUser.role === 'owner') {
            channelLockedBanner.style.display = 'none';
            chatForm.style.display = 'flex';
            chatInput.placeholder = 'Post announcement as Owner...';
        } else {
            chatForm.style.display = 'none';
            channelLockedBanner.style.display = 'block';
        }
        loadAnnouncements();
    } else if (channel === 'general') {
        channelLockedBanner.style.display = 'none';
        chatForm.style.display = 'flex';
        chatInput.placeholder = 'Message #general... (use @name to ping)';
        loadGeneralMessages();
    }
}

// ================= 6. GROUP VC (LOUNGE) & DEAFEN =================
async function joinLoungeVC() {
    if (inLoungeVC) return;
    try {
        vcLocalAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        inLoungeVC = true;
        vcConnectedDock.style.display = 'flex';

        socket.emit('join_server_vc');
        setupLocalSpeakingDetection(vcLocalAudioStream);
        playChime('join');
    } catch (err) {
        alert('Microphone access is required to join the voice lounge.');
    }
}

async function createVcPeerConnection(targetSocketId, isInitiator) {
    const pc = new RTCPeerConnection(rtcConfig);
    vcPeers.set(targetSocketId, pc);

    if (vcLocalAudioStream) {
        vcLocalAudioStream.getTracks().forEach(t => pc.addTrack(t, vcLocalAudioStream));
    }

    if (vcLocalScreenStream) {
        vcLocalScreenStream.getTracks().forEach(t => pc.addTrack(t, vcLocalScreenStream));
    }

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('vc_peer_signal', { targetSocketId, signalData: { candidate: event.candidate } });
        }
    };

    pc.ontrack = (event) => {
        if (event.track.kind === 'audio') {
            let audio = document.getElementById(`vc-audio-${targetSocketId}`);
            if (!audio) {
                audio = document.createElement('audio');
                audio.id = `vc-audio-${targetSocketId}`;
                audio.autoplay = true;
                vcAudioPool.appendChild(audio);
            }
            audio.srcObject = event.streams[0];
            audio.muted = isLoungeDeafened;
            setupRemoteSpeakingDetection(event.streams[0]);
        } else if (event.track.kind === 'video') {
            vcScreenVideo.srcObject = event.streams[0];
            vcScreenContainer.style.display = 'flex';
        }
    };

    if (isInitiator) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('vc_peer_signal', { targetSocketId, signalData: offer });
    }

    return pc;
}

dockDisconnectBtn.onclick = () => { leaveLoungeVC(); };

function leaveLoungeVC() {
    if (!inLoungeVC) return;
    inLoungeVC = false;
    vcConnectedDock.style.display = 'none';

    stopVcScreenShare();
    if (vcLocalAudioStream) {
        vcLocalAudioStream.getTracks().forEach(t => t.stop());
        vcLocalAudioStream = null;
    }

    vcPeers.forEach(pc => pc.close());
    vcPeers.clear();
    vcAudioPool.innerHTML = '';

    socket.emit('leave_server_vc');
    playChime('leave');

    vcScreenContainer.style.display = 'none';
    vcScreenVideo.srcObject = null;
    if (activeChannel === 'vc') openServerChannel('general');
}

dockMuteBtn.onclick = () => {
    if (vcLocalAudioStream) {
        const audioTrack = vcLocalAudioStream.getAudioTracks()[0];
        audioTrack.enabled = !audioTrack.enabled;
        dockMuteBtn.innerText = audioTrack.enabled ? 'Mute' : 'Unmute';
        dockMuteBtn.classList.toggle('active', !audioTrack.enabled);
    }
};

dockDeafenBtn.onclick = () => {
    isLoungeDeafened = !isLoungeDeafened;
    dockDeafenBtn.classList.toggle('active', isLoungeDeafened);
    dockDeafenBtn.innerText = isLoungeDeafened ? 'Undeafen' : 'Deafen';

    if (vcLocalAudioStream) {
        const audioTrack = vcLocalAudioStream.getAudioTracks()[0];
        audioTrack.enabled = !isLoungeDeafened;
        dockMuteBtn.innerText = audioTrack.enabled ? 'Mute' : 'Unmute';
        dockMuteBtn.classList.toggle('active', !audioTrack.enabled);
    }

    document.querySelectorAll('#vc-audio-pool audio').forEach(a => {
        a.muted = isLoungeDeafened;
    });
};

dockScreenBtn.onclick = async () => {
    if (!inLoungeVC) return;
    if (!vcLocalScreenStream) {
        try {
            vcLocalScreenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
            const screenTrack = vcLocalScreenStream.getVideoTracks()[0];

            vcScreenVideo.srcObject = vcLocalScreenStream;
            vcScreenContainer.style.display = 'flex';
            dockScreenBtn.innerText = 'Stop';

            vcPeers.forEach(pc => {
                pc.addTrack(screenTrack, vcLocalScreenStream);
                pc.createOffer().then(offer => {
                    pc.setLocalDescription(offer);
                    for (const [sockId, peerPC] of vcPeers.entries()) {
                        if (peerPC === pc) {
                            socket.emit('vc_peer_signal', { targetSocketId: sockId, signalData: offer });
                        }
                    }
                });
            });

            screenTrack.onended = () => { stopVcScreenShare(); };
        } catch (e) { console.log('Screen share cancelled'); }
    } else {
        stopVcScreenShare();
    }
};

function stopVcScreenShare() {
    if (vcLocalScreenStream) {
        vcLocalScreenStream.getTracks().forEach(t => t.stop());
        vcLocalScreenStream = null;
        dockScreenBtn.innerText = 'Screen';
        vcScreenContainer.style.display = 'none';
        vcScreenVideo.srcObject = null;
    }
}

function renderVcOccupantsTree() {
    vcOccupantsList.innerHTML = '';
    vcMembersList.forEach(m => {
        const li = document.createElement('li');
        li.className = 'vc-occupant-item';
        li.innerHTML = `
            <div class="avatar-wrapper">${createAvatarElement(m.username, m.avatar_url)}</div>
            <span>${m.username}</span>
        `;
        vcOccupantsList.appendChild(li);
    });
}

function renderVcStageGrid() {
    vcParticipantsGrid.innerHTML = '';
    vcMembersList.forEach(m => {
        const card = document.createElement('div');
        card.className = 'vc-grid-card';
        const isSelf = m.userId === currentUser.id;
        const volumeControlHtml = !isSelf 
            ? `<input type="range" min="0" max="1" step="0.05" value="1" class="vc-volume-slider" title="Volume" oninput="setPeerVolume('${m.socketId}', this.value)">`
            : '';

        card.innerHTML = `
            <div class="avatar-wrapper" id="vc-avatar-${m.userId}">${createAvatarElement(m.username, m.avatar_url)}</div>
            <span class="vc-grid-name">${m.username}</span>
            ${volumeControlHtml}
        `;
        vcParticipantsGrid.appendChild(card);
    });
}

window.setPeerVolume = function(socketId, val) {
    const audio = document.getElementById(`vc-audio-${socketId}`);
    if (audio) audio.volume = val;
};

// ================= 7. ANNOUNCEMENTS & GENERAL =================
function formatMentions(text) {
    return text.replace(/@([a-zA-Z0-9_]+)/g, '<span class="mention-tag">@$1</span>');
}

function handleSmartAutoScroll(callback) {
    const isAtBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop <= messagesContainer.clientHeight + 80;
    callback();
    if (isAtBottom) {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
}

async function loadAnnouncements() {
    try {
        const res = await fetch(`${SERVER_URL}/api/announcements`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const items = await res.json();
        items.forEach(appendAnnouncement);
    } catch (err) { console.error(err); }
}

function appendAnnouncement(item) {
    handleSmartAutoScroll(() => {
        const msg = document.createElement('div');
        msg.className = 'message';
        msg.id = `announcement-${item.id}`;

        const date = new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const deleteBtnHtml = currentUser.role === 'owner' 
            ? `<button class="delete-btn" onclick="deleteAnnouncement(${item.id})">Delete</button>` 
            : '';

        const formattedContent = typeof marked !== 'undefined' ? marked.parse(formatMentions(item.content)) : formatMentions(item.content);

        msg.innerHTML = `
            <div class="avatar-wrapper">${createAvatarElement(item.username, item.avatar_url)}</div>
            <div class="message-content">
                <div class="message-header">
                    <span class="message-author">${item.username}</span>
                    <span class="author-tag">Owner</span>
                    <span class="message-time">${date}</span>
                    ${deleteBtnHtml}
                </div>
                <div class="message-body">${formattedContent}</div>
            </div>
        `;
        messagesContainer.appendChild(msg);
    });
}

window.deleteAnnouncement = async function(id) {
    await fetch(`${SERVER_URL}/api/announcements/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
    });
};

async function loadGeneralMessages() {
    try {
        const res = await fetch(`${SERVER_URL}/api/general-messages`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const items = await res.json();
        items.forEach(appendGeneralMessage);
    } catch (err) { console.error(err); }
}

function appendGeneralMessage(item) {
    handleSmartAutoScroll(() => {
        const msg = document.createElement('div');
        const isMentioned = item.content.includes(`@${currentUser.username}`);
        msg.className = `message ${isMentioned ? 'mentioned' : ''}`;
        msg.id = `gen-msg-${item.id}`;

        const isMe = item.user_id === currentUser.id;
        const canDelete = isMe || currentUser.role === 'owner';
        const deleteBtnHtml = canDelete 
            ? `<button class="delete-btn" onclick="deleteGeneralMessage(${item.id})">Delete</button>` 
            : '';

        const date = new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const formattedContent = typeof marked !== 'undefined' ? marked.parse(formatMentions(item.content)) : formatMentions(item.content);

        msg.innerHTML = `
            <div class="avatar-wrapper">${createAvatarElement(item.username, item.avatar_url)}</div>
            <div class="message-content">
                <div class="message-header">
                    <span class="message-author">${item.username}</span>
                    <span class="message-time">${date}</span>
                    ${deleteBtnHtml}
                </div>
                <div class="message-body">${formattedContent}</div>
            </div>
        `;
        messagesContainer.appendChild(msg);
    });
}

window.deleteGeneralMessage = async function(id) {
    await fetch(`${SERVER_URL}/api/general-messages/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
    });
};

// ================= 8. FRIENDS & DMs =================
async function loadFriends() {
    try {
        const res = await fetch(`${SERVER_URL}/api/friends`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        friendsList = await res.json();
        renderFriendsList();
    } catch (err) { console.error(err); }
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
                ${createAvatarElement(friend.username, friend.avatar_url, `friend-${friend.id}`)}
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
    } catch (err) { console.error(err); }
});

async function openDM(friend) {
    activeFriend = friend;
    renderFriendsList();

    chatHeaderPrefix.innerText = '@';
    chatHeaderTitle.innerText = friend.username;
    callHeaderAction.style.display = 'block';
    chatInput.placeholder = `Message @${friend.username}... (Ctrl+V image)`;
    messagesContainer.innerHTML = '';

    try {
        const res = await fetch(`${SERVER_URL}/api/messages/${friend.id}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const messages = await res.json();
        messages.forEach(m => {
            const isMe = m.sender_id === currentUser.id;
            const author = isMe ? currentUser.username : friend.username;
            appendMessage(author, m.content, m.created_at, m.avatar_url, m.id, isMe);
        });
    } catch (err) { console.error(err); }
}

chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        chatForm.dispatchEvent(new Event('submit'));
    }
});

chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;

    if (activeView === 'server') {
        if (activeChannel === 'announcements') {
            await fetch(`${SERVER_URL}/api/announcements`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ content: text })
            });
        } else if (activeChannel === 'general') {
            await fetch(`${SERVER_URL}/api/general-messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ content: text })
            });
        }
    } else if (activeView === 'dms' && activeFriend) {
        socket.emit('send_dm', { receiverId: activeFriend.id, content: text });
    }

    chatInput.value = '';
});

function appendMessage(author, text, createdAt, avatarUrl, id, isMe) {
    handleSmartAutoScroll(() => {
        const msg = document.createElement('div');
        const isMentioned = text.includes(`@${currentUser.username}`);
        msg.className = `message ${isMentioned ? 'mentioned' : ''}`;
        msg.id = `msg-${id}`;

        const date = new Date(createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const canDelete = isMe || currentUser.role === 'owner';
        const deleteBtnHtml = canDelete 
            ? `<button class="delete-btn" onclick="deleteDMMessage(${id})">Delete</button>` 
            : '';

        const formattedContent = typeof marked !== 'undefined' ? marked.parse(formatMentions(text)) : formatMentions(text);

        msg.innerHTML = `
            <div class="avatar-wrapper">${createAvatarElement(author, avatarUrl)}</div>
            <div class="message-content">
                <div class="message-header">
                    <span class="message-author">${author}</span>
                    <span class="message-time">${date}</span>
                    ${deleteBtnHtml}
                </div>
                <div class="message-body">${formattedContent}</div>
            </div>
        `;
        messagesContainer.appendChild(msg);
    });
}

window.deleteDMMessage = async function(id) {
    await fetch(`${SERVER_URL}/api/messages/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
    });
};

// ================= 9. 1-ON-1 CALLS & DEAFEN =================
async function setupPeerConnection() {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    peerConnection = new RTCPeerConnection(rtcConfig);

    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    peerConnection.ontrack = (event) => {
        if (event.track.kind === 'video') {
            remoteVideo.srcObject = event.streams[0];
            remoteVideo.style.display = 'block';
        } else if (event.track.kind === 'audio') {
            remoteAudio.srcObject = event.streams[0];
            remoteAudio.muted = isCallDeafened;
            setupRemoteSpeakingDetection(event.streams[0]);
        }
    };

    peerConnection.onicecandidate = (event) => {
        if (event.candidate && activeFriend) {
            socket.emit('ice_candidate', { targetUserId: activeFriend.id, candidate: event.candidate });
        }
    };

    setupLocalSpeakingDetection(localStream);
}

deafenCallBtn.onclick = () => {
    isCallDeafened = !isCallDeafened;
    deafenCallBtn.classList.toggle('active', isCallDeafened);
    deafenCallBtn.innerText = isCallDeafened ? 'Undeafen' : 'Deafen';

    if (localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        audioTrack.enabled = !isCallDeafened;
        muteMicBtn.innerText = audioTrack.enabled ? 'Mute' : 'Unmute';
        muteMicBtn.classList.toggle('active', !audioTrack.enabled);
    }

    remoteAudio.muted = isCallDeafened;
};

function setupLocalSpeakingDetection(stream) {
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioContext.createAnalyser();
        const mic = audioContext.createMediaStreamSource(stream);
        mic.connect(analyser);
        analyser.fftSize = 256;

        const buffer = new Uint8Array(analyser.frequencyBinCount);
        const myAvatar = document.getElementById('my-avatar-btn');

        speakingInterval = setInterval(() => {
            analyser.getByteFrequencyData(buffer);
            let total = buffer.reduce((a, b) => a + b, 0);
            let avg = total / buffer.length;

            if (avg > 25) {
                myAvatar.classList.add('speaking');
                const vcSelf = document.getElementById(`vc-avatar-${currentUser.id}`);
                if (vcSelf) vcSelf.classList.add('speaking');
            } else {
                myAvatar.classList.remove('speaking');
                const vcSelf = document.getElementById(`vc-avatar-${currentUser.id}`);
                if (vcSelf) vcSelf.classList.remove('speaking');
            }
        }, 100);
    } catch (e) { console.error(e); }
}

function setupRemoteSpeakingDetection(stream) {
    try {
        const remoteCtx = new (window.AudioContext || window.webkitAudioContext)();
        const remoteAnalyser = remoteCtx.createAnalyser();
        const remoteSource = remoteCtx.createMediaStreamSource(stream);
        remoteSource.connect(remoteAnalyser);
        remoteAnalyser.fftSize = 256;

        const buffer = new Uint8Array(remoteAnalyser.frequencyBinCount);
        setInterval(() => {
            remoteAnalyser.getByteFrequencyData(buffer);
            let total = buffer.reduce((a, b) => a + b, 0);
            let avg = total / buffer.length;

            if (activeFriend) {
                const friendAvatar = document.getElementById(`avatar-friend-${activeFriend.id}`);
                if (friendAvatar) {
                    if (avg > 25) friendAvatar.classList.add('speaking');
                    else friendAvatar.classList.remove('speaking');
                }
            }
        }, 100);
    } catch (e) { console.error(e); }
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

screenShareBtn.addEventListener('click', async () => {
    if (!peerConnection) return;
    try {
        if (!screenStream) {
            screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
            const screenTrack = screenStream.getVideoTracks()[0];

            peerConnection.addTrack(screenTrack, screenStream);
            screenShareBtn.innerText = 'Stop Sharing';

            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            socket.emit('renegotiate_offer', { targetUserId: activeFriend.id, offer });

            screenTrack.onended = () => { stopScreenShare(); };
        } else {
            stopScreenShare();
        }
    } catch (err) { console.error(err); }
});

function stopScreenShare() {
    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
        screenStream = null;
        screenShareBtn.innerText = 'Share Screen';
    }
}

muteMicBtn.addEventListener('click', () => {
    if (localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        audioTrack.enabled = !audioTrack.enabled;
        muteMicBtn.innerText = audioTrack.enabled ? 'Mute' : 'Unmute';
        muteMicBtn.classList.toggle('active', !audioTrack.enabled);
    }
});

endCallBtn.addEventListener('click', () => {
    if (activeFriend) {
        socket.emit('end_call', { targetUserId: activeFriend.id });
    }
    endCallCleanly();
});

function endCallCleanly() {
    stopScreenShare();
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    if (speakingInterval) clearInterval(speakingInterval);
    if (audioContext) audioContext.close();

    remoteVideo.srcObject = null;
    remoteVideo.style.display = 'none';
    activeCallPanel.style.display = 'none';
    isCallDeafened = false;
    deafenCallBtn.classList.remove('active');
    deafenCallBtn.innerText = 'Deafen';
}

// ================= 10. TAB TRACKER & TIMER =================
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
    } catch (err) { console.log('Tab cancelled'); }
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
