import { hashPinForTopic, deriveKey, encryptData, decryptData } from './crypto.js';
import { scrollToBottom, showScreen, setConnectionStatus, addMessageToUI, rebuildChatUI, playNotificationSound, applyPrivacyMode, closeImageViewer } from './ui.js';
//npx cap copy android
// --- Global State ---
let client = null;
let cryptoKey = null;
let localChatHistory = []; 
let currentPin = ""; 
let currentTopic = "";
let peerPushId = null; 
let offlineQueue = [];
let isReconnecting = false;
let isPrivacyMode = false;
let savedRooms = JSON.parse(localStorage.getItem('bchat_rooms')) || [];
let roomNames = JSON.parse(localStorage.getItem('bchat_names')) || {};
let lockedRooms = JSON.parse(localStorage.getItem('bchat_locked_rooms')) || [];
let lastPushSentTime = 0; 
let pressTimer;
let isLongPress = false;
let selectedPinForOptions = null;

let unreadRooms = JSON.parse(localStorage.getItem('bchat_unread')) || [];
const isNativeApp = window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();

if (isNativeApp) {
    document.body.classList.add('is-native');
} else {
    document.body.classList.add('is-web');
}

// --- Initialization ---

let storedClientId = localStorage.getItem("mqtt_client_id");
if (!storedClientId) {
  storedClientId = "bc_user_" + Date.now() + "_" + Math.random().toString(16).substr(2, 8);
  localStorage.setItem("mqtt_client_id", storedClientId);
}
const MY_CLIENT_ID = storedClientId;


let BROKER_URL = ""; 
let BROKER_PORT = 8884; 
let BROKER_USER = "";
let BROKER_PASS = ""; 

// --- Helpers ---
function messageExists(id) {
  return localChatHistory.some(m => m.id === id);
}


async function authenticateUser(reasonText) {
    if (isNativeApp && window.Capacitor && window.Capacitor.Plugins.NativeBiometric) {
        try {
            const NativeBiometric = window.Capacitor.Plugins.NativeBiometric;
            await NativeBiometric.verifyIdentity({
                reason: reasonText,
                title: "App Security",
                subtitle: "Verify identity to proceed"
            });
            return true;
        } catch (error) {
            console.log("Biometric Auth Failed", error);
            return false;
        }
    }
    return false; 
}

async function fetchMqttCreds() {
    if (BROKER_URL !== "") return;
    try {
        const res = await fetch("https://secure-room-proxy.mark-fili25.workers.dev/get-mqtt");
        const creds = await res.json();
        BROKER_URL = creds.url;
        BROKER_USER = creds.user;
        BROKER_PASS = creds.pass;
    } catch (err) {
        console.log("Error restore credentials MQTT");
    }
}

function queueOrSend(message, requiresPush = false) {
    if (client && client.isConnected()) {
        client.send(message);
        
        if (requiresPush && peerPushId) {
            const now = Date.now();

            if (now - lastPushSentTime > 10000) {
                sendPushNotification(peerPushId, "New Secure Message");
                lastPushSentTime = now;
            }
        }
    } else {
        offlineQueue.push({ msg: message, push: requiresPush });
    }
}

function startAutodestructTimer(msgId, delay = 10000) {
  setTimeout(() => {
      localChatHistory = localChatHistory.filter(m => m.id !== msgId);
      saveHistory(); 
      rebuildChatUI(localChatHistory); 
  }, delay); 
}

async function saveHistory() {
  if (!currentPin || !cryptoKey) return;
  try {
      const encryptedData = await encryptData(localChatHistory, cryptoKey);
      localStorage.setItem(`bchat_history_${currentPin}`, encryptedData);
      
      if (localChatHistory.length > 0) {
          const lastMsg = localChatHistory[localChatHistory.length - 1];
          localStorage.setItem(`bchat_meta_${currentPin}`, lastMsg.time);
      } else {
          localStorage.removeItem(`bchat_meta_${currentPin}`); 
      }
  } catch (error) {}
}

async function loadHistory(pin) {
  const saved = localStorage.getItem(`bchat_history_${pin}`);
  if (saved) {
    try { 
        const decryptedArray = await decryptData(saved, cryptoKey);
        if (decryptedArray && Array.isArray(decryptedArray)) {
            localChatHistory = decryptedArray; 
            const now = Date.now();
            
            localChatHistory = localChatHistory.filter(msg => {
                if (msg.isBomb) {
                    const timePassed = now - msg.time;
                    if (timePassed < 10000) {
                        startAutodestructTimer(msg.id, 10000 - timePassed);
                        return true; 
                    } else {
                        return false; 
                    }
                }
                return true;
            });
            saveHistory(); 
            if (localChatHistory.length > 0) {
                localStorage.setItem(`last_read_${pin}`, localChatHistory[localChatHistory.length - 1].id);
            }
        } else {
            localChatHistory = [];
        }
    } catch (e) { 
        localChatHistory = []; 
    }
  } else { 
      localChatHistory = []; 
  }
}

function resetInputState() {
  const input = document.getElementById('message_input');
  const attachIcon = document.querySelector('#attach-btn ion-icon');
  const panelIcon = document.querySelector('#panel-bomb-icon');
  
  if (input) input.value = '';
  if (attachIcon) {
      attachIcon.setAttribute('name', 'add');
      attachIcon.style.color = '';
  }
  if (panelIcon) {
      panelIcon.setAttribute('name', 'radio-button-off');
      panelIcon.style.color = '';
  }
}

function formatLastActive(timestamp) {
    if (!timestamp) return "Awaiting connection..."; 
    
    const date = new Date(parseInt(timestamp));
    const now = new Date();
    const isToday = date.getDate() === now.getDate() && date.getMonth() === 
    now.getMonth() && date.getFullYear() === now.getFullYear();

    if (isToday) {
        return "Last active: " + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const isYesterday = date.getDate() === yesterday.getDate() && date.getMonth() === 
    yesterday.getMonth() && date.getFullYear() === yesterday.getFullYear();
    
    if (isYesterday) {
        return "Last active: Yesterday";
    }

    return "Last active: " + date.toLocaleDateString();
}

// --- Push Notifications ---

function setupPushIdentity() {
    const broadcastId = (id) => {
        if (!id) return;

        const pushTopic = `blackchat/users/${currentTopic}/${MY_CLIENT_ID}/push_id`;
        const payload = JSON.stringify({ pushId: id, mqttId: MY_CLIENT_ID });
        const message = new Paho.MQTT.Message(payload);
        message.destinationName = pushTopic;
        message.retained = true;
        queueOrSend(message, false);
    };


    if (window.plugins && window.plugins.OneSignal) {
        const os = window.plugins.OneSignal;

        setTimeout(() => {
            const nativeId = os.User.pushSubscription.id;
            if (nativeId) broadcastId(nativeId);
        }, 1000);

        os.User.pushSubscription.addEventListener("change", function(event) {
            if (event.current && event.current.id) broadcastId(event.current.id);
        });
    } 

    else if (window.OneSignalDeferred) {
        window.OneSignalDeferred.push(function(OneSignal) {
            setTimeout(() => {
                const webId = OneSignal.User.PushSubscription.id;
                if (webId) broadcastId(webId);
            }, 1000);

            OneSignal.User.PushSubscription.addEventListener("change", function(event) {
                if (event.current && event.current.id) broadcastId(event.current.id);
            });
            OneSignal.Slidedown.promptPush();
        });
    }
}

async function sendPushNotification(targetId, text) {
    const BACKEND_URL = "https://secure-room-proxy.mark-fili25.workers.dev"; 
    const displayPin = currentPin.substring(0, 4) + "*";
    const realPin = currentPin;

    try {
        await fetch(BACKEND_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
                targetId: targetId, 
                pin: displayPin,
                fullPin: realPin 
            })
        });
    } catch (error) {}
}

// --- Connection Handlers ---
const roomOptionsOverlay = document.getElementById('room-options-overlay');

function showRoomOptions(pin, roomElement) {
    if (navigator.vibrate) navigator.vibrate(50);
    selectedPinForOptions = pin;
    const displayPin = pin.substring(0, 4) + '*';
    const currentName = roomNames[pin];
    
    document.getElementById('options-room-title').innerText = currentName ? currentName : `Room ${displayPin}`;
    
    const rect = roomElement.getBoundingClientRect();
    const actionMenu = document.querySelector('#room-options-overlay .action-menu');
    actionMenu.style.visibility = 'hidden';
    actionMenu.style.display = 'block'; 
    
    const menuHeight = actionMenu.offsetHeight || 150; 
    
    actionMenu.style.visibility = '';
    actionMenu.style.display = '';
    
    const spaceBelow = window.innerHeight - rect.top;

    if (spaceBelow < (menuHeight + 60)) {
        actionMenu.style.top = (rect.bottom - menuHeight - 100) + 'px';
        actionMenu.style.transformOrigin = "bottom right"; 
    } else {
        actionMenu.style.top = (rect.top + 43) + 'px';
        actionMenu.style.transformOrigin = "top right";
    }
    
    actionMenu.style.right = (window.innerWidth - rect.right) + 'px';

    actionMenu.style.right = (window.innerWidth - rect.right) + 'px';
    
    const lockBtn = document.getElementById('btn-lock-room');

    if (lockBtn) {
        if (!isNativeApp) {
            lockBtn.style.display = 'none';
        } else {
            lockBtn.style.display = ''; 
            
            if (lockedRooms.includes(pin)) {
                lockBtn.innerText = "Unlock Room";
                
            } else {
                lockBtn.innerText = "Lock Room";
                
            }
        }
    }

    roomOptionsOverlay.classList.add('active');
}

if (roomOptionsOverlay) {
    roomOptionsOverlay.addEventListener('click', (e) => {
        if (e.target === roomOptionsOverlay) {
            roomOptionsOverlay.classList.remove('active');
        }
    });
}

document.getElementById('btn-remove-room')?.addEventListener('click', () => {
    savedRooms = savedRooms.filter(p => p !== selectedPinForOptions);
    localStorage.setItem('bchat_rooms', JSON.stringify(savedRooms));
    delete roomNames[selectedPinForOptions];
    localStorage.setItem('bchat_names', JSON.stringify(roomNames));
    
    roomOptionsOverlay.classList.remove('active');
    renderRoomList();
});

document.getElementById('btn-custom-name')?.addEventListener('click', () => {
    roomOptionsOverlay.classList.remove('active');
    
    if (document.activeElement) {
        document.activeElement.blur();
    }

    setTimeout(() => {
        const currentName = roomNames[selectedPinForOptions] || "";
        const newName = prompt("Enter a custom name for this room:", currentName);
        
        if (newName !== null) {
            if (newName.trim() === "") {
                delete roomNames[selectedPinForOptions]; 
            } else {
                roomNames[selectedPinForOptions] = newName.trim();
            }
            localStorage.setItem('bchat_names', JSON.stringify(roomNames));
            renderRoomList();
        }

        setTimeout(() => {
            window.scrollTo(0, 0);
            document.body.style.height = '99%';
            window.requestAnimationFrame(() => {
                document.body.style.height = '100%';
            });
        }, 100);

    }, 500);
});

document.getElementById('btn-lock-room')?.addEventListener('click', async () => {
    roomOptionsOverlay.classList.remove('active');
    
    const isLocked = lockedRooms.includes(selectedPinForOptions);
    const actionText = isLocked ? "Verify identity to Unlock Chat" : "Verify identity to Lock Chat";
    
    const isAuthenticated = await authenticateUser(actionText);
    
    if (isAuthenticated) {
        if (isLocked) {
            lockedRooms = lockedRooms.filter(p => p !== selectedPinForOptions);
        } else {
            lockedRooms.push(selectedPinForOptions); 
        }
        localStorage.setItem('bchat_locked_rooms', JSON.stringify(lockedRooms));
        
        renderRoomList();
        if (navigator.vibrate) navigator.vibrate(50);
    }
});

function renderRoomList() {
    const container = document.getElementById('room-list-container');
    if (!container) return;
    container.innerHTML = '';
    
    savedRooms.forEach(pin => {
        const displayPin = pin.substring(0, 4) + '*'; 
        const lastActiveRaw = localStorage.getItem(`bchat_meta_${pin}`);
        const lastActiveText = formatLastActive(lastActiveRaw);
        
        const roomTitle = roomNames[pin] ? roomNames[pin] : `Room ${displayPin}`;

        const isLocked = lockedRooms.includes(pin);
        const lockIconHtml = isLocked ? `<ion-icon name="lock-closed" style="color: var(--text-muted); font-size: 1.1rem; margin-left: 6px;"></ion-icon>` : '';

        const roomDiv = document.createElement('div');
        roomDiv.className = 'room-item';
        
        roomDiv.oncontextmenu = (e) => { e.preventDefault(); return false; };


        const isUnread = unreadRooms.includes(pin);
        
        const unreadDotHtml = isUnread ? `<div class="unread-dot" style="background-color: var(--primary); width: 12px; height: 12px; border-radius: 50%; margin-left: auto; margin-right: 10px; box-shadow: 0 0 8px var(--primary); flex-shrink: 0;"></div>` : '';

        roomDiv.innerHTML = `
          <div class="room-avatar"><ion-icon name="lock-closed"></ion-icon></div>
          <div class="room-details" style="flex-grow: 1;"> <div class="room-name" style="display:flex; align-items:center;">${roomTitle} ${lockIconHtml}</div>
            <div class="room-last-msg">${lastActiveText}</div>
          </div>
          ${unreadDotHtml}
        `;

        const startPress = (e) => {
            isLongPress = false;
            pressTimer = setTimeout(() => {
                isLongPress = true;
                showRoomOptions(pin, roomDiv); 
            }, 500);
        };

        const cancelPress = () => {
            clearTimeout(pressTimer);
        };

        roomDiv.addEventListener('mousedown', startPress);
        roomDiv.addEventListener('touchstart', startPress, { passive: true });
        
        roomDiv.addEventListener('mouseup', cancelPress);
        roomDiv.addEventListener('mouseleave', cancelPress);
        roomDiv.addEventListener('touchend', cancelPress);
        roomDiv.addEventListener('touchmove', cancelPress);

        roomDiv.onclick = (e) => {
            if (isLongPress) {
                e.preventDefault();
                return;
            }
            enterRoomWithRipple(pin, e);
        };

        container.appendChild(roomDiv);
    });
}

async function enterRoom(pin) {
    if (!pin) return;

    if (lockedRooms.includes(pin)) {
        const isAuthenticated = await authenticateUser("Unlock Secure Room");
        if (!isAuthenticated) {
            const addBtn = document.getElementById('add-room-btn');
            if (addBtn) {
                addBtn.classList.remove('shake-error-vertical');
                void addBtn.offsetWidth; 
                addBtn.classList.add('shake-error-vertical');
                setTimeout(() => addBtn.classList.remove('shake-error-vertical'), 400);
            }
            return; 
        }
    }

    if (isNativeApp && window.plugins && window.plugins.OneSignal) {
        window.plugins.OneSignal.Notifications.clearAll();
    }

    unreadRooms = unreadRooms.filter(p => p !== pin);
    localStorage.setItem('bchat_unread', JSON.stringify(unreadRooms));
    renderRoomList(); 

    if (pin.length < 8) {
        const roomListScreen = document.getElementById('room-list-screen');
        const isRoomListVisible = roomListScreen && roomListScreen.offsetWidth > 0;

        if (isRoomListVisible) {
            const addBtn = document.getElementById('add-room-btn');
            const statusList = document.getElementById('status-list');

            if (statusList) {
                statusList.innerText = "SECURITY ALERT: Min 8 characters.";
                setTimeout(() => { statusList.innerText = ""; }, 5000);
            }

            if (addBtn) {
                addBtn.classList.remove('shake-error-vertical');
                void addBtn.offsetWidth; 
                addBtn.classList.add('shake-error-vertical');
                setTimeout(() => addBtn.classList.remove('shake-error-vertical'), 400);
            }
        } else {
            const connectBtn = document.getElementById('connect-btn');
            const loginStatus = document.getElementById('status-text');

            if (loginStatus) {
                loginStatus.innerText = "SECURITY ALERT: Passphrase must be at least 8 characters long.";
            }

            if (connectBtn) {
                connectBtn.classList.remove('shake-error'); 
                void connectBtn.offsetWidth; 
                connectBtn.classList.add('shake-error');
                setTimeout(() => { connectBtn.classList.remove('shake-error'); }, 400);
            }
        }
        return; 
    }

    if (!savedRooms.includes(pin)) {
        savedRooms.push(pin);
        localStorage.setItem('bchat_rooms', JSON.stringify(savedRooms));
        renderRoomList();
    }

    currentPin = pin;
    currentTopic = await hashPinForTopic(pin);
    cryptoKey = await deriveKey(pin);

    await loadHistory(currentPin);
    rebuildChatUI(localChatHistory);
    
    isPrivacyMode = false;
    localStorage.setItem('secure_room_privacy', 'false');
    applyPrivacyMode(false);

    showScreen('chat-screen');
    setConnectionStatus(false, currentPin.substring(0, 4) + "*", "Connecting to Cloud...");

    await fetchMqttCreds();


    if (!client || !client.isConnected()) {
        await fetchMqttCreds();
        client = new Paho.MQTT.Client(BROKER_URL, BROKER_PORT, MY_CLIENT_ID);
        client.onConnectionLost = onConnectionLost;
        client.onMessageArrived = onMessageArrived; 

        client.connect({
            userName: BROKER_USER, password: BROKER_PASS, useSSL: true,
            cleanSession: false, keepAliveInterval: 30, timeout: 3,
            onSuccess: onConnect,
            onFailure: (err) => {
                setConnectionStatus(false, currentPin.substring(0, 4) + "*", "Connection Error");
            }
        });
    } else {

        client.onMessageArrived = onMessageArrived;
        onConnect();
    }
}

function disconnect() {
  isReconnecting = false;
  offlineQueue = []; 
  if (client) { try { client.disconnect(); } catch(e){} }
  
  client = null; 
  cryptoKey = null; 
  currentPin = "";
  currentTopic = "";
  localChatHistory = [];
  
  const pinInput = document.getElementById('pin_input');
  if (pinInput) pinInput.value = '';
  resetInputState();
  document.getElementById('chat-messages').innerHTML = '';

  setTimeout(() => { document.getElementById('status-text').innerHTML = "Disconnected."; }, 500);
  setTimeout(() => { document.getElementById('status-text').innerHTML = "Disconnected.."; }, 800);
  setTimeout(() => { document.getElementById('status-text').innerHTML = "Disconnected..."; }, 1100);
  setTimeout(() => { document.getElementById('status-text').innerHTML = "Chat Deletion."; }, 1400);
  setTimeout(() => { document.getElementById('status-text').innerHTML = "Chat Deletion.."; }, 1800);
  setTimeout(() => { document.getElementById('status-text').innerHTML = "Chat Deletion..."; }, 2200);
  setTimeout(() => { document.getElementById('status-text').innerHTML = "Clearing Data."; }, 2500);
  setTimeout(() => { document.getElementById('status-text').innerHTML = "Clearing Data.."; }, 2800);
  setTimeout(() => { document.getElementById('status-text').innerHTML = "Clearing Data..."; }, 3100);
  setTimeout(() => { document.getElementById('status-text').innerHTML = ""; }, 3400);

  const chatScreen = document.getElementById('chat-screen');
  if (chatScreen) chatScreen.classList.remove('chat-focus-in');

  if (savedRooms.length > 0) {
      renderRoomList();
      showScreen('room-list-screen');
      setTimeout(connectBackgroundMQTT, 500);
  } else {
      showScreen('login-screen');
  }
}


function backToRoomList() {
    disconnect();
}

function onConnect() {
    setConnectionStatus(true, currentPin.substring(0, 4) + "*", "Online");
    client.subscribe(`blackchat/room/${currentTopic}`, { qos: 1 });

    client.subscribe(`blackchat/users/${currentTopic}/+/push_id`, { qos: 1 });
    setupPushIdentity();

    if (offlineQueue.length > 0) {
        let needsPush = false;
        while(offlineQueue.length > 0) {
            const item = offlineQueue.shift();
            client.send(item.msg);
            if (item.push) needsPush = true;
        }
        
        if (needsPush && peerPushId) {
            const now = Date.now();
            if (now - lastPushSentTime > 10000) {
                sendPushNotification(peerPushId, "New Secure Message");
                lastPushSentTime = now;
            }
        }
    }
}

async function reconnect() {
    if (!currentPin || !client || client.isConnected() || isReconnecting) return;
    
    isReconnecting = true;
    setConnectionStatus(false, currentPin.substring(0, 4) + "*", "Reconnecting...");

    await fetchMqttCreds();

    client.connect({
        userName: BROKER_USER,
        password: BROKER_PASS,
        useSSL: true, cleanSession: false, keepAliveInterval: 30, timeout: 3,
        onSuccess: () => {
            isReconnecting = false;
            onConnect(); 
        },
        onFailure: (err) => {
            isReconnecting = false;
            setTimeout(reconnect, 3000); 
        }
    });
}

function onConnectionLost(responseObject) {
  setConnectionStatus(false, currentPin.substring(0, 4) + "*", `Disconnected`);
  if (responseObject.errorCode !== 0 && currentPin) {
    setTimeout(reconnect, 1000);
  }
}

// --- Message Handlers ---

function initOneSignalNativo() {
    if (window.plugins && window.plugins.OneSignal) {
        const os = window.plugins.OneSignal;
        os.initialize("fbcbc6a0-8e00-4bd6-b389-c2fc6676ece2");

        os.Notifications.addEventListener('click', function(event) {
            const data = event.notification.additionalData;
            let incomingPin = data ? (data.roomPin || data.fullPin || data.pin) : null;

            if (incomingPin) {
                if (incomingPin.includes('*')) {
                    const prefix = incomingPin.replace('*', '');
                    const matchedRoom = savedRooms.find(p => p.startsWith(prefix));
                    if (matchedRoom) incomingPin = matchedRoom;
                }

                unreadRooms = unreadRooms.filter(p => p !== incomingPin);
                localStorage.setItem('bchat_unread', JSON.stringify(unreadRooms));
                
                setTimeout(() => {
                    if (currentPin && currentPin !== incomingPin) {
                        disconnect();
                    }
                    
                    if (currentPin !== incomingPin) {
                        enterRoom(incomingPin); 
                    }
                }, 500);
            }
        });

        os.Notifications.addEventListener('foregroundWillDisplay', function(event) {
            const data = event.notification.additionalData;
            let incomingPin = data ? (data.roomPin || data.fullPin || data.pin) : null;
            
            if (incomingPin) {
                if (incomingPin.includes('*')) {
                    const prefix = incomingPin.replace('*', '');
                    const matchedRoom = savedRooms.find(p => p.startsWith(prefix));
                    if (matchedRoom) incomingPin = matchedRoom;
                }

                if (savedRooms.includes(incomingPin) && currentPin !== incomingPin) {
                    if (!unreadRooms.includes(incomingPin)) {
                        unreadRooms.push(incomingPin);
                        localStorage.setItem('bchat_unread', JSON.stringify(unreadRooms));
                        renderRoomList();
                    }
                }
            }
        });
    }
}

document.addEventListener('deviceready', initOneSignalNativo, false);


async function onMessageArrived(message) {
  if (message.destinationName.includes("push_id")) {
    try {
        const info = JSON.parse(message.payloadString);
        if (info.mqttId !== MY_CLIENT_ID) peerPushId = info.pushId;
    } catch (e) {}
    return;
  }
  
  const data = await decryptData(message.payloadString, cryptoKey);
  if (!data || data.senderId === MY_CLIENT_ID) return;

  if (data.type === 'WIPE') {
      localChatHistory = [];
      localStorage.removeItem(`bchat_history_${currentPin}`);
      localStorage.removeItem(`bchat_meta_${currentPin}`);
      
      savedRooms = savedRooms.filter(pin => pin !== currentPin);
      localStorage.setItem('bchat_rooms', JSON.stringify(savedRooms));
      
      rebuildChatUI(localChatHistory);
      disconnect(); 
      return;
  }

  if (data.type === 'DEL_MSG') {
      const initialLength = localChatHistory.length;
      localChatHistory = localChatHistory.filter(m => m.id !== data.id);
      
      if (localChatHistory.length !== initialLength) {
          saveHistory();
          rebuildChatUI(localChatHistory);
      }
      return; 
  }

  if ((data.type === 'MSG' || data.type === 'IMG' || data.type === 'LOC' || data.type === 'DOC') && !messageExists(data.id)) {
      let msgType = 'text';
      if (data.type === 'IMG') msgType = 'image';
      if (data.type === 'LOC') msgType = 'location';
      if (data.type === 'DOC') msgType = 'document'; 
      
      const msgObj = { 
        id: data.id, sender: 'peer', text: data.text, time: Date.now(), 
        isBomb: data.isBomb, msgType: msgType,
        fileName: data.fileName || (msgType === 'location' ? 'location.gps' : (msgType === 'document' ? 'document.pdf' : 'image.jpg'))
      };
      
      localChatHistory.push(msgObj);
      saveHistory();
      addMessageToUI(msgObj.text, 'peer', data.isBomb, msgObj.msgType, msgObj.fileName);
      playNotificationSound();

      localStorage.setItem(`last_read_${currentPin}`, data.id);
      
      if (data.isBomb) startAutodestructTimer(data.id);
  }
}

async function sendMessage() {
  const input = document.getElementById('message_input');
  const text = input.value.trim();
  
  const attachIcon = document.querySelector('#attach-btn ion-icon');
  const panelIcon = document.querySelector('#panel-bomb-icon');
  const isBombActive = (attachIcon && attachIcon.getAttribute('name') === 'radio-button-on') || 
                       (panelIcon && panelIcon.getAttribute('name') === 'radio-button-on');
  
  if (!text) return;

  if (text === `exit`) { resetInputState(); disconnect(); return; }
  
  if (text === `clear`) { 
      localChatHistory = []; 
      localStorage.removeItem(`bchat_history_${currentPin}`);
      localStorage.removeItem(`bchat_meta_${currentPin}`); 
      document.getElementById("chat-messages").innerHTML = ''; 
      resetInputState(); 
      return; 
  }

  if (text.toLowerCase() === 'wipe') {
    localStorage.removeItem(`bchat_history_${currentPin}`);
    localStorage.removeItem(`bchat_meta_${currentPin}`);

    savedRooms = savedRooms.filter(pin => pin !== currentPin);
    localStorage.setItem('bchat_rooms', JSON.stringify(savedRooms));
    
    if (roomNames[currentPin]) {
        delete roomNames[currentPin];
        localStorage.setItem('bchat_names', JSON.stringify(roomNames));
    }
    localChatHistory = [];
    currentPin = "";
    currentTopic = "";
    cryptoKey = null;

    if (client && client.isConnected()) {
        client.disconnect();
    }

    document.getElementById('message_input').value = '';
    resetInputState();
    
    renderRoomList();
    showScreen('room-list-screen');
    
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      
    return; 
  }

  if (text.toLowerCase() === `sweet pink muffin`) {
      document.body.classList.remove('light-theme'); 
      const isPink = document.body.classList.toggle('pink-theme');
      
     
      localStorage.setItem('bchat_theme', isPink ? 'pink' : 'dark');
      
      if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
      resetInputState(); 
      return; 
  }

  const msgIdText = Date.now() + '-txt-' + Math.random().toString(36).substr(2, 9);
  const msgObjText = { id: msgIdText, sender: 'me', text: text, time: Date.now(), isBomb: isBombActive };
  
  localChatHistory.push(msgObjText);
  saveHistory();
  addMessageToUI(text, 'me', isBombActive);
  
  const payloadObjText = { type: 'MSG', text: text, id: msgIdText, senderId: MY_CLIENT_ID, isBomb: isBombActive };
  const encryptedText = await encryptData(payloadObjText, cryptoKey);
  const messageText = new Paho.MQTT.Message(encryptedText);
  messageText.destinationName = `blackchat/room/${currentTopic}`;
  messageText.qos = 1; messageText.retained = true; 
  queueOrSend(messageText, true);
  
  if (isBombActive) startAutodestructTimer(msgIdText);
  resetInputState(); 
}

function processAndSendImage(e) {
  const file = e.target.files[0];
  if (!file) return;
  
  const originalFileName = file.name || 'secure_photo.jpg';
  const reader = new FileReader();
  
  reader.onload = function(event) {
      const img = new Image();
      img.onload = async function() {
          const canvas = document.createElement('canvas');
          let width = img.width; let height = img.height;
          if (width > height) { if (width > 800) { height *= 800 / width; width = 800; } } 
          else { if (height > 800) { width *= 800 / height; height = 800; } }
          
          canvas.width = width; canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);

          const base64Img = canvas.toDataURL('image/jpeg', 0.6);
          const msgId = Date.now() + '-img-' + Math.random().toString(36).substr(2, 9);
          
          const attachIcon = document.querySelector('#attach-btn ion-icon');
          const panelIcon = document.querySelector('#panel-bomb-icon');
          const isBombActive = (attachIcon && attachIcon.getAttribute('name') === 'radio-button-on') || 
                               (panelIcon && panelIcon.getAttribute('name') === 'radio-button-on');

          const msgObj = { id: msgId, sender: 'me', text: base64Img, time: Date.now(), isBomb: isBombActive, msgType: 'image', fileName: originalFileName };
          localChatHistory.push(msgObj);
          saveHistory();
          addMessageToUI(base64Img, 'me', isBombActive, 'image', originalFileName);

          const payloadObj = { type: 'IMG', text: base64Img, id: msgId, senderId: MY_CLIENT_ID, isBomb: isBombActive, fileName: originalFileName };
          const encrypted = await encryptData(payloadObj, cryptoKey);
          const message = new Paho.MQTT.Message(encrypted);
          message.destinationName = `blackchat/room/${currentTopic}`;
          message.qos = 1; message.retained = true; 
          queueOrSend(message, true);
          
          if (isBombActive) startAutodestructTimer(msgId);
          resetInputState();
          e.target.value = ''; 
      }
      img.src = event.target.result;
  }
  reader.readAsDataURL(file);
}

// --- Event Listeners & UI Handlers ---
function animateButton(btn) {
  if (!btn) return;
  btn.style.transform = 'scale(0.9)';
  setTimeout(() => { btn.style.transform = ''; }, 150); 
}

function handleSend(e) {
  if (e) { e.preventDefault(); animateButton(e.currentTarget); }
  sendMessage();
}

function handleAttach(e) {
  if (e) { e.preventDefault(); animateButton(e.currentTarget); }
  const attachIcon = document.querySelector('#attach-btn ion-icon');
  const panelIcon = document.querySelector('#panel-bomb-icon');
  const currentIcon = attachIcon.getAttribute('name');
  const panel = document.getElementById('attachment-panel');
  
  if (currentIcon === 'add') {
    panel.classList.toggle('open');
  } else if (currentIcon === 'radio-button-off') {
    attachIcon.setAttribute('name', 'radio-button-on');
    attachIcon.style.color = 'var(--danger)';
    if (panelIcon) { panelIcon.setAttribute('name', 'radio-button-on'); panelIcon.style.color = 'var(--danger)'; }
  } else if (currentIcon === 'radio-button-on') {
    attachIcon.setAttribute('name', 'radio-button-off');
    attachIcon.style.color = ''; 
    if (panelIcon) { panelIcon.setAttribute('name', 'radio-button-off'); panelIcon.style.color = ''; }
  }
}

function handlePanelBomb(e) {
  if (e) { e.preventDefault(); animateButton(e.currentTarget.querySelector('ion-icon')); }
  const panelIcon = document.querySelector('#panel-bomb-icon');
  const attachIcon = document.querySelector('#attach-btn ion-icon');
  
  if (panelIcon.getAttribute('name') === 'radio-button-off') {
    panelIcon.setAttribute('name', 'radio-button-on');
    panelIcon.style.color = 'var(--danger)';
    if (attachIcon && attachIcon.getAttribute('name') !== 'add') {
        attachIcon.setAttribute('name', 'radio-button-on');
        attachIcon.style.color = 'var(--danger)';
    }
  } else {
    panelIcon.setAttribute('name', 'radio-button-off');
    panelIcon.style.color = '';
    if (attachIcon && attachIcon.getAttribute('name') !== 'add') {
        attachIcon.setAttribute('name', 'radio-button-off');
        attachIcon.style.color = '';
    }
  }
}

function closeAttachmentPanel() {
  const panel = document.getElementById('attachment-panel');
  if (panel) panel.classList.remove('open');
}


const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || 
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function handleGallery(e) {
  if (e && e.type !== 'click') { e.preventDefault(); }
  if (e) animateButton(e.currentTarget);
  closeAttachmentPanel();
  
  if (isIOS) {
      document.getElementById('image_input_gallery').click();
  } else {
      setTimeout(() => { document.getElementById('image_input_gallery').click(); }, 150);
  }
}

async function handleCamera(e) {
 if (e && e.type !== 'click') { e.preventDefault(); }
  animateButton(e.currentTarget);
  closeAttachmentPanel();
  
  if (window.Capacitor && window.Capacitor.Plugins.Camera) {
      try {
          const image = await window.Capacitor.Plugins.Camera.getPhoto({
              quality: 60, 
              allowEditing: false,
              resultType: 'dataUrl',
              source: 'CAMERA',      
              width: 800 
          });

          const base64Img = image.dataUrl;
          const originalFileName = 'secure_camera.jpg';

          const attachIcon = document.querySelector('#attach-btn ion-icon');
          const panelIcon = document.querySelector('#panel-bomb-icon');
          const isBombActive = (attachIcon && attachIcon.getAttribute('name') === 'radio-button-on') || 
                               (panelIcon && panelIcon.getAttribute('name') === 'radio-button-on');

          const msgId = Date.now() + '-img-' + Math.random().toString(36).substr(2, 9);
          const msgObj = { id: msgId, sender: 'me', text: base64Img, time: Date.now(), isBomb: isBombActive, msgType: 'image', fileName: originalFileName };
          
          localChatHistory.push(msgObj);
          saveHistory();
          addMessageToUI(base64Img, 'me', isBombActive, 'image', originalFileName);

          const payloadObj = { type: 'IMG', text: base64Img, id: msgId, senderId: MY_CLIENT_ID, isBomb: isBombActive, fileName: originalFileName };
          const encrypted = await encryptData(payloadObj, cryptoKey);
          const message = new Paho.MQTT.Message(encrypted);
          message.destinationName = `blackchat/room/${currentTopic}`;
          message.qos = 1; message.retained = true; 
          queueOrSend(message, true);

          if (isBombActive) startAutodestructTimer(msgId);
          resetInputState();

      } catch (error) {
          console.log("Camera Error", error);
      }
  } 
  else {
      if (isIOS) {
          document.getElementById('image_input_camera').click();
      } else {
          setTimeout(() => { document.getElementById('image_input_camera').click(); }, 150);
      }
  }
}

function handleDocument(e) {
  if (e && e.type !== 'click') { e.preventDefault(); }
  if (e) animateButton(e.currentTarget);
  closeAttachmentPanel();
  
  if (isIOS) {
      document.getElementById('doc_input').click();
  } else {
      setTimeout(() => { document.getElementById('doc_input').click(); }, 150);
  }
}


async function handleLocation(e) {
    if (e && e.type !== 'click') { e.preventDefault(); }
    if (e) animateButton(e.currentTarget);
    closeAttachmentPanel();

    const attachIcon = document.querySelector('#attach-btn ion-icon');
    const panelIcon = document.querySelector('#panel-bomb-icon');
    const isBombActive = (attachIcon && attachIcon.getAttribute('name') === 'radio-button-on') || 
                         (panelIcon && panelIcon.getAttribute('name') === 'radio-button-on');

    const inviaPosizione = async (lat, lon) => {

        const mapsUrl = `https://maps.google.com/?q=${lat},${lon}`;
        const fileName = "location.gps";
        const msgId = Date.now() + '-loc-' + Math.random().toString(36).substr(2, 9);

        const msgObj = { id: msgId, sender: 'me', text: mapsUrl, time: Date.now(), isBomb: isBombActive, msgType: 'location', fileName: fileName };
        localChatHistory.push(msgObj);
        saveHistory();
        addMessageToUI(mapsUrl, 'me', isBombActive, 'location', fileName);

        const payloadObj = { type: 'LOC', text: mapsUrl, id: msgId, senderId: MY_CLIENT_ID, isBomb: isBombActive, fileName: fileName };
        const encrypted = await encryptData(payloadObj, cryptoKey);
        const message = new Paho.MQTT.Message(encrypted);
        message.destinationName = `blackchat/room/${currentTopic}`;
        message.qos = 1; message.retained = true; 
        queueOrSend(message, true);

        if (isBombActive) startAutodestructTimer(msgId);
        resetInputState();
    };

    try {

        if (window.Capacitor && window.Capacitor.Plugins.Geolocation) {
            const Geo = window.Capacitor.Plugins.Geolocation;
            

            const checkPerms = await Geo.checkPermissions();
            if (checkPerms.location !== 'granted') {
                const reqPerms = await Geo.requestPermissions();
                if (reqPerms.location !== 'granted') {
                    alert("Permessi GPS negati.");
                    return;
                }
            }

            const position = await Geo.getCurrentPosition();
            inviaPosizione(position.coords.latitude, position.coords.longitude);
        } 

        else {
            if (!navigator.geolocation) { alert("GPS not supported"); return; }
            navigator.geolocation.getCurrentPosition(
                (pos) => inviaPosizione(pos.coords.latitude, pos.coords.longitude),
                (err) => alert("Access Denied.")
            );
        }
    } catch (err) {
        alert("Error GPS: Permissions Denied");
    }
}

function enterRoomWithRipple(pin, event) {
    const expander = document.createElement('div');
    expander.className = 'dark-transition-expander';
    document.body.appendChild(expander);

    void expander.offsetWidth; 

    expander.classList.add('expand');

    setTimeout(() => {
        enterRoom(pin);
        expander.classList.add('fade-out');
        
        setTimeout(() => {
            expander.remove();
        }, 600); 
        
    }, 500); 
}


window.sendMessage = sendMessage;
window.enterRoom = enterRoom;
window.backToRoomList = backToRoomList;

const msgInput = document.getElementById('message_input');
if (msgInput) {
    msgInput.addEventListener('click', scrollToBottom);
    msgInput.addEventListener('focus', scrollToBottom);
    msgInput.addEventListener('keydown', function(event) {
      if (event.key === 'Enter') sendMessage();
    });
    msgInput.addEventListener('input', function() {
      closeAttachmentPanel(); 
      const attachIcon = document.querySelector('#attach-btn ion-icon');
      const panelIcon = document.querySelector('#panel-bomb-icon');
      const isBomb = panelIcon ? panelIcon.getAttribute('name') === 'radio-button-on' : false;
      
      if (this.value.trim().length > 0) {
        if (attachIcon.getAttribute('name') === 'add') {
          attachIcon.setAttribute('name', isBomb ? 'radio-button-on' : 'radio-button-off');
          attachIcon.style.color = isBomb ? 'var(--danger)' : '';
        }
      } else {
        attachIcon.setAttribute('name', 'add'); 
        attachIcon.style.color = ''; 
      }
    });
}

const pinInput = document.getElementById('pin_input');
if (pinInput) {
    pinInput.addEventListener('keydown', function(event) {
        if (event.key === 'Enter') enterRoom(this.value.trim());
    });
    pinInput.addEventListener('input', function() {
        const loginStatus = document.getElementById('status-text');
        if (loginStatus) loginStatus.innerText = "";
    });
}

const connectBtn = document.getElementById('connect-btn');
if (connectBtn) {
    connectBtn.addEventListener('click', () => {
        if (pinInput) enterRoom(pinInput.value.trim());
    });
}

const addRoomBtn = document.getElementById('add-room-btn');
const newRoomOverlay = document.getElementById('new-room-overlay');
const overlayConnectBtn = document.getElementById('overlay-connect-btn');
const overlayPinInput = document.getElementById('overlay_room_pin');

if (addRoomBtn && newRoomOverlay) {
    addRoomBtn.addEventListener('click', () => {
        newRoomOverlay.classList.add('active');
        addRoomBtn.style.display = 'none'; 
        if (overlayPinInput) overlayPinInput.focus();
    });

    newRoomOverlay.addEventListener('click', (e) => {
        if (e.target === newRoomOverlay) {
            newRoomOverlay.classList.remove('active');
            addRoomBtn.style.display = 'flex'; 
            if (overlayPinInput) overlayPinInput.value = '';
        }
    });
}

function handleOverlayConnect() {
    if (!overlayPinInput) return;
    const pin = overlayPinInput.value.trim();
    
    if (pin.length < 8) {
        const statusOverlay = document.getElementById('overlay-status');
        if (statusOverlay) {
            statusOverlay.innerText = "SECURITY ALERT: Min 8 characters.";
            setTimeout(() => { statusOverlay.innerText = ""; }, 3000);
        }
        if (overlayConnectBtn) {
            overlayConnectBtn.classList.remove('shake-error');
            void overlayConnectBtn.offsetWidth;
            overlayConnectBtn.classList.add('shake-error');
            setTimeout(() => overlayConnectBtn.classList.remove('shake-error'), 400);
        }
        return;
    }

    newRoomOverlay.classList.remove('active');
    const addBtn = document.getElementById('add-room-btn');
    if(addBtn) addBtn.style.display = 'flex';

    overlayPinInput.value = '';
    enterRoom(pin);
}

if (overlayConnectBtn) {
    overlayConnectBtn.addEventListener('click', handleOverlayConnect);
}

if (overlayPinInput) {
    overlayPinInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleOverlayConnect();
    });
    overlayPinInput.addEventListener('input', () => {
        const statusOverlay = document.getElementById('overlay-status');
        if (statusOverlay) statusOverlay.innerText = "";
    });
}


async function connectBackgroundMQTT() {
    if (client && client.isConnected()) return;

    await fetchMqttCreds();
    client = new Paho.MQTT.Client(BROKER_URL, BROKER_PORT, MY_CLIENT_ID + "_bg");
    client.onConnectionLost = onConnectionLost;
    client.onMessageArrived = onBackgroundMessageArrived; 

    client.connect({
        userName: BROKER_USER,
        password: BROKER_PASS,
        useSSL: true,
        cleanSession: false,
        keepAliveInterval: 30,
        timeout: 3,
        onSuccess: async () => {
            console.log("Background MQTT Connected");

            for (const pin of savedRooms) {
                const topic = await hashPinForTopic(pin);
                client.subscribe(`blackchat/room/${topic}`, { qos: 1 });
            }
        },
        onFailure: (err) => console.log("Background MQTT failed")
    });
}


async function onBackgroundMessageArrived(message) {

    if (currentPin) return; 

    const incomingTopic = message.destinationName.split('/').pop();

    for (const pin of savedRooms) {
        const expectedTopic = await hashPinForTopic(pin);
        
        if (incomingTopic === expectedTopic) {
            
            
            try {
                const tempKey = await deriveKey(pin);
                const data = await decryptData(message.payloadString, tempKey);
                

                if (data && data.senderId !== MY_CLIENT_ID && !data.type.includes('WIPE')) {
                    const lastReadId = localStorage.getItem(`last_read_${pin}`);
                    if (data.id === lastReadId) {
                        break; 
                    }

                    if (!unreadRooms.includes(pin)) {
                        unreadRooms.push(pin);
                        localStorage.setItem('bchat_unread', JSON.stringify(unreadRooms));
                        renderRoomList(); 
                    }
                }
            } catch (e) {

            }
            break; 
        }
    }
}



window.addEventListener('load', async () => {
    const overlay = document.getElementById('transition-overlay');
    if (overlay) {
        setTimeout(() => { overlay.classList.remove('active'); }, 1500);
    }
    
    if (savedRooms.length > 0) {
        renderRoomList();
        showScreen('room-list-screen');
        await connectBackgroundMQTT();
    } else {
        showScreen('login-screen');
    }
});

applyPrivacyMode(isPrivacyMode);

const chatHeader = document.querySelector('.chat-header');
let lastTapTime = 0;

if (chatHeader) {
    chatHeader.addEventListener('click', function(e) {
      if (e.target.classList.contains('header-lock') || e.target.closest('.header-lock')) {
        isPrivacyMode = !isPrivacyMode; 
        localStorage.setItem('secure_room_privacy', isPrivacyMode); 
        applyPrivacyMode(isPrivacyMode); 
        return;
      }

      const currentTime = new Date().getTime();
      const tapLength = currentTime - lastTapTime;
      
      if (tapLength < 500 && tapLength > 0) {
        if (currentPin) { disconnect(); }
      }
      lastTapTime = currentTime;
    });
}

window.addEventListener('popstate', (event) => {
  const chatScreen = document.getElementById('chat-screen');
  if (chatScreen && chatScreen.classList.contains('active')) {
    event.preventDefault(); disconnect(); 
  }
});

document.addEventListener('click', function(event) {
  const panel = document.getElementById('attachment-panel');
  const attachBtn = document.getElementById('attach-btn');
  if (panel && panel.classList.contains('open')) {
    if (!panel.contains(event.target) && (!attachBtn || !attachBtn.contains(event.target))) {
      closeAttachmentPanel();
    }
  }
});

const sendBtn = document.getElementById('send-btn');
const attachBtn = document.getElementById('attach-btn');
const btnPanelBomb = document.getElementById('panel-bomb-toggle');
const btnGallery = document.getElementById('btn-gallery');
const btnCamera = document.getElementById('btn-camera');
const btnLocation = document.getElementById('btn-location');
const btnDocument = document.getElementById('btn-document');


const imgGalleryInput = document.getElementById('image_input_gallery');
const imgCameraInput = document.getElementById('image_input_camera');
const closeViewerBtn = document.getElementById('close-viewer-btn');
const docInput = document.getElementById('doc_input')
const downloadViewerBtn = document.getElementById('download-viewer-btn');

if (downloadViewerBtn) {
    downloadViewerBtn.addEventListener('click', async () => {
        const imgEl = document.getElementById('viewer-image');
        const nameEl = document.getElementById('viewer-filename');
        
        if (!imgEl || !imgEl.src) return;

        const base64Data = imgEl.src;
        const filename = (nameEl && nameEl.innerText && nameEl.innerText !== "Foto") 
                         ? nameEl.innerText 
                         : 'secure_image_' + Date.now() + '.jpg';

        
        if (isNativeApp && window.Capacitor && window.Capacitor.Plugins.Filesystem) {
            try {
                const Filesystem = window.Capacitor.Plugins.Filesystem;
                
                const base64String = base64Data.split(',')[1]; 
                
                await Filesystem.writeFile({
                    path: filename,
                    data: base64String,
                    directory: 'DOCUMENTS' 
                });

                alert("Image Saved Successfully ");
            } catch (err) {
                console.log("Error", err);
                alert("Error" + (err.message || JSON.stringify(err))); 
            }
        }
        else {
            const a = document.createElement('a');
            a.href = base64Data;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }
    });
}

if (imgGalleryInput) imgGalleryInput.addEventListener('change', processAndSendImage);
if (imgCameraInput) imgCameraInput.addEventListener('change', processAndSendImage);
if (closeViewerBtn) closeViewerBtn.addEventListener('click', closeImageViewer);

if (docInput) {
    docInput.addEventListener('change', function(e) {
      const file = e.target.files[0];
      if (!file) return;

      const MAX_FILE_SIZE = 2 * 1024 * 1024; 
      if (file.size > MAX_FILE_SIZE) {
          alert("File too big [MAX 2MB]");
          e.target.value = '';
          return;
      }

      const originalFileName = file.name;
      const attachIcon = document.querySelector('#attach-btn ion-icon');
      const panelIcon = document.querySelector('#panel-bomb-icon');
      const isBombActive = (attachIcon && attachIcon.getAttribute('name') === 'radio-button-on') || 
                           (panelIcon && panelIcon.getAttribute('name') === 'radio-button-on');

      const reader = new FileReader();
      reader.onload = async function(event) {
          const base64Doc = event.target.result; 
          const msgId = Date.now() + '-doc-' + Math.random().toString(36).substr(2, 9);

          const msgObj = { id: msgId, sender: 'me', text: base64Doc, time: Date.now(), isBomb: isBombActive, msgType: 'document', fileName: originalFileName };
          localChatHistory.push(msgObj);
          saveHistory();
          addMessageToUI(base64Doc, 'me', isBombActive, 'document', originalFileName);

          const payloadObj = { type: 'DOC', text: base64Doc, id: msgId, senderId: MY_CLIENT_ID, isBomb: isBombActive, fileName: originalFileName };
          const encrypted = await encryptData(payloadObj, cryptoKey);
          const message = new Paho.MQTT.Message(encrypted);
          message.destinationName = `blackchat/room/${currentTopic}`;
          message.qos = 1; message.retained = true; 
          queueOrSend(message, true);
          
          if (isBombActive) startAutodestructTimer(msgId);
          resetInputState();
          e.target.value = ''; 
      };
      
      reader.readAsDataURL(file); 
    });
}

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
        isPrivacyMode = true;
        localStorage.setItem('secure_room_privacy', 'true');
        applyPrivacyMode(true);
    }
    else if (document.visibilityState === "visible" && currentPin) {
        if (client && !client.isConnected()) {
            reconnect();
        }
    }
});

window.addEventListener("online", () => {
    if (currentPin && client && !client.isConnected()) {
        reconnect();
    }
});


const btnGlobalOptions = document.getElementById('btn-global-options');
const globalOptionsOverlay = document.getElementById('global-options-overlay');

if (btnGlobalOptions && globalOptionsOverlay) {
    btnGlobalOptions.addEventListener('click', () => {
        globalOptionsOverlay.classList.add('active');
    });

    globalOptionsOverlay.addEventListener('click', (e) => {
        if (e.target === globalOptionsOverlay) {
            globalOptionsOverlay.classList.remove('active');
        }
    });
}



let autoDownloadState = localStorage.getItem('bchat_autodownload') === 'true';
const btnGlobalAutoDownload = document.getElementById('btn-global-autodownload');
const autoDownloadText = document.getElementById('autodownload-text');

function updateAutoDownloadUI() {
    if (autoDownloadText) {
        autoDownloadText.innerText = autoDownloadState ? "Auto Download: Active" : "Auto Download: None";
    }
    if (downloadViewerBtn) {
        downloadViewerBtn.style.display = autoDownloadState ? 'none' : 'flex';
    }
}


updateAutoDownloadUI();

if (btnGlobalAutoDownload) {
    btnGlobalAutoDownload.addEventListener('click', () => {
        autoDownloadState = !autoDownloadState; 
        localStorage.setItem('bchat_autodownload', autoDownloadState);
        updateAutoDownloadUI();
        if (navigator.vibrate) navigator.vibrate(50);
    });
}

const btnGlobalWipe = document.getElementById('btn-global-wipe');
if (btnGlobalWipe) {
    btnGlobalWipe.addEventListener('click', () => {
        const confirmWipe = confirm("⚠️ WIPE ALL DATA?\n\nThis will permanently delete all rooms, messages, and cryptographic keys from this device. Cannot be undone.");
        
        if (confirmWipe) {
            savedRooms.forEach(pin => {
                localStorage.removeItem(`bchat_history_${pin}`);
                localStorage.removeItem(`bchat_meta_${pin}`);
            });
            localStorage.removeItem('bchat_rooms');
            localStorage.removeItem('bchat_names');
            savedRooms = [];
            roomNames = {};
            
            globalOptionsOverlay.classList.remove('active');
            renderRoomList();
            showScreen('login-screen');
        } else {
            globalOptionsOverlay.classList.remove('active');
        }
    });
}


const savedTheme = localStorage.getItem('bchat_theme');
if (savedTheme === 'light') {
    document.body.classList.add('light-theme');
} else if (savedTheme === 'pink') {
    document.body.classList.add('pink-theme');
}

const btnGlobalTheme = document.getElementById('btn-global-theme');

function updateThemeUI() {
    if (!btnGlobalTheme) return;
    
    if (document.body.classList.contains('light-theme')) {
        btnGlobalTheme.innerHTML = `Select Theme: White`;
    } else {
        btnGlobalTheme.innerHTML = `Select Theme: Black`;
    }
}

updateThemeUI();

if (btnGlobalTheme) {
    btnGlobalTheme.addEventListener('click', () => {
        if (document.body.classList.contains('pink-theme')) {
            document.body.classList.remove('pink-theme');
            document.body.classList.add('light-theme');
            localStorage.setItem('bchat_theme', 'light');
        } else {
            const isLight = document.body.classList.toggle('light-theme');
            localStorage.setItem('bchat_theme', isLight ? 'light' : 'dark');
        }
        
        updateThemeUI();
        
        if (navigator.vibrate) navigator.vibrate(50);
    });
}


if (window.Capacitor && window.Capacitor.Plugins.Keyboard) {

    const Keyboard = window.Capacitor.Plugins.Keyboard;

    Keyboard.addListener('keyboardWillShow', (info) => {
        const appContainer = document.getElementById('app-container');
        if (appContainer) {
            const offsetAndroid = 57; 
            appContainer.style.bottom = `calc(${info.keyboardHeight}px - ${offsetAndroid}px)`;
            
            setTimeout(() => {
                const chat = document.getElementById("chat-messages");
                if (chat) chat.scrollTop = chat.scrollHeight;
            }, 100);
        }
    });

    Keyboard.addListener('keyboardWillHide', () => {
        const appContainer = document.getElementById('app-container');
        if (appContainer) {
            appContainer.style.bottom = '1rem'; 
        }
    });
}


if (!isNativeApp && window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
        const appContainer = document.getElementById('app-container');
        if (appContainer) {
            appContainer.style.height = `${window.visualViewport.height}px`;
            
            setTimeout(() => {
                window.scrollTo(0, 0);
                const chat = document.getElementById("chat-messages");
                if (chat) chat.scrollTop = chat.scrollHeight;
            }, 100);
        }
    });

   
    document.addEventListener('touchmove', (e) => {
        if (e.target.closest('#chat-messages') || e.target.closest('.room-list-body')) {
            return; 
        }
        e.preventDefault(); 
    }, { passive: false });
}


function bindSmartButton(btn, handler) {
    if (!btn) return;
    if (isIOS) {
        btn.addEventListener('click', handler);
    } else {
        btn.addEventListener('mousedown', handler);
        btn.addEventListener('touchstart', handler, { passive: false });
    }
}

bindSmartButton(sendBtn, handleSend);
bindSmartButton(attachBtn, handleAttach);
bindSmartButton(btnPanelBomb, handlePanelBomb);
bindSmartButton(btnGallery, handleGallery);
bindSmartButton(btnCamera, handleCamera);
bindSmartButton(btnLocation, handleLocation);
bindSmartButton(btnDocument, handleDocument);

const chatContainerNode = document.getElementById('chat-messages');
const msgOptionsOverlay = document.getElementById('msg-options-overlay');

let msgPressTimer;
let isMsgLongPress = false;
let selectedMsgIndex = -1;

function showMsgOptions(wrapperElement) {
    if (navigator.vibrate) navigator.vibrate(50);
    
    const bubble = wrapperElement.querySelector('.msg-bubble');
    const rect = bubble.getBoundingClientRect(); 
    const actionMenu = msgOptionsOverlay.querySelector('.action-menu');
    
    const overlayRect = msgOptionsOverlay.getBoundingClientRect();
    const relativeTop = rect.top - overlayRect.top;
    const relativeBottom = rect.bottom - overlayRect.top;
    const relativeLeft = rect.left - overlayRect.left;
    const relativeRight = overlayRect.width - (rect.right - overlayRect.left);

    actionMenu.style.visibility = 'hidden';
    actionMenu.style.display = 'block';

    const menuHeight = actionMenu.offsetHeight || 50;

    actionMenu.style.visibility = '';
    actionMenu.style.display = '';

    const spaceBelow = window.innerHeight - rect.bottom;

    if (spaceBelow < (menuHeight + 20)) {
        actionMenu.style.top = (relativeTop - menuHeight - 3) + 'px'; 
        actionMenu.style.transformOrigin = "bottom center";
    } else {
        actionMenu.style.top = (relativeBottom + 3) + 'px'; 
        actionMenu.style.transformOrigin = "top center";
    }

    if (wrapperElement.classList.contains('me')) {
        actionMenu.style.right = relativeRight + 'px';
        actionMenu.style.left = 'auto';
    } else {
        actionMenu.style.left = relativeLeft + 'px';
        actionMenu.style.right = 'auto';
    }

    msgOptionsOverlay.classList.add('active');
}

function cancelMsgPress() {
    clearTimeout(msgPressTimer);
}

if (chatContainerNode) {
    
    const startMsgPress = (e) => {
        if (e.type === 'mousedown') {
            const input = document.getElementById('message_input');
            if (document.activeElement === input) e.preventDefault();
        }

        const wrapper = e.target.closest('.msg-wrapper');
        if (!wrapper) return;

        isMsgLongPress = false;
        selectedMsgIndex = Array.from(chatContainerNode.children).indexOf(wrapper);

        msgPressTimer = setTimeout(() => {
            isMsgLongPress = true;
            showMsgOptions(wrapper);
        }, 500); 
    };

    chatContainerNode.addEventListener('mousedown', startMsgPress);
    chatContainerNode.addEventListener('touchstart', startMsgPress, { passive: true });
    
    chatContainerNode.addEventListener('mouseup', cancelMsgPress);
    chatContainerNode.addEventListener('mouseleave', cancelMsgPress);
    chatContainerNode.addEventListener('touchend', cancelMsgPress);
    chatContainerNode.addEventListener('touchmove', cancelMsgPress);

    chatContainerNode.addEventListener('contextmenu', (e) => {
        const wrapper = e.target.closest('.msg-wrapper');
        if (wrapper) {
            e.preventDefault();
            isMsgLongPress = true;
            selectedMsgIndex = Array.from(chatContainerNode.children).indexOf(wrapper);
            showMsgOptions(wrapper);
        }
    });

    chatContainerNode.addEventListener('click', (e) => {
        if (isMsgLongPress) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        if (!chatContainerNode.classList.contains('privacy-mode')) return;

        const bubble = e.target.closest('.msg-bubble');
        if (!bubble) return;

        if (!bubble.classList.contains('revealed')) {
            e.preventDefault();
            e.stopPropagation();
            bubble.classList.add('revealed');
            bubble.revealTimer = setTimeout(() => {
                bubble.classList.remove('revealed');
                delete bubble.revealTimer;
            }, 5000);
            if (navigator.vibrate) navigator.vibrate(50);
        } else {
            clearTimeout(bubble.revealTimer);
            bubble.revealTimer = setTimeout(() => {
                bubble.classList.remove('revealed');
                delete bubble.revealTimer;
            }, 5000);
        }
    }, true);
}

const btnDeleteMsg = document.getElementById('btn-delete-msg');
if (btnDeleteMsg) {
    btnDeleteMsg.addEventListener('click', async () => {
        if (selectedMsgIndex > -1 && selectedMsgIndex < localChatHistory.length) {
            
            const msgToDelete = localChatHistory[selectedMsgIndex];
            const msgId = msgToDelete.id;

            localChatHistory.splice(selectedMsgIndex, 1); 
            saveHistory();
            rebuildChatUI(localChatHistory);

            if (cryptoKey && currentTopic) {
                const payloadObj = { type: 'DEL_MSG', id: msgId, senderId: MY_CLIENT_ID };
                const encrypted = await encryptData(payloadObj, cryptoKey);
                const mqttMsg = new Paho.MQTT.Message(encrypted);
                mqttMsg.destinationName = `blackchat/room/${currentTopic}`;
                mqttMsg.qos = 1;
                mqttMsg.retained = true; 
                queueOrSend(mqttMsg, false);
            }
        }
        
        if (msgOptionsOverlay) msgOptionsOverlay.classList.remove('active');
        selectedMsgIndex = -1;
    });
}

if (msgOptionsOverlay) {
    msgOptionsOverlay.addEventListener('click', (e) => {
        if (e.target === msgOptionsOverlay) {
            msgOptionsOverlay.classList.remove('active');
            selectedMsgIndex = -1;
        }
    });
}