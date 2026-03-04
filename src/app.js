import { hashPinForTopic, deriveKey, encryptData, decryptData } from './crypto.js';
import { scrollToBottom, showScreen, setConnectionStatus, addMessageToUI, keepKeyboardOpen,
rebuildChatUI, playNotificationSound, applyPrivacyMode, closeImageViewer } from './ui.js';

// --- Global State ---
let client = null;
let cryptoKey = null;
let localChatHistory = []; 
let currentPin = ""; 
let currentTopic = "";
let peerPushId = null; 
let offlineQueue = [];
let isReconnecting = false;

// --- Initialization ---
let storedClientId = localStorage.getItem("mqtt_client_id");
if (!storedClientId) {
  storedClientId = "bc_user_" + Date.now() + "_" + Math.random().toString(16).substr(2, 8);
  localStorage.setItem("mqtt_client_id", storedClientId);
}
const MY_CLIENT_ID = storedClientId;

const BROKER_URL = "broker.emqx.io"; 
const BROKER_PORT = 8084; 

// --- Helpers ---
function messageExists(id) {
  return localChatHistory.some(m => m.id === id);
}

function queueOrSend(message, requiresPush = false) {
    if (client && client.isConnected()) {
        client.send(message);
        if (requiresPush && peerPushId) sendPushNotification(peerPushId, "New Secure Message");
    } else {
        console.log("Client offline. Message added to queue.");
        offlineQueue.push({ msg: message, push: requiresPush });
    }
}

function startAutodestructTimer(msgId, delay = 10000) {
  setTimeout(() => {
      localChatHistory = localChatHistory.filter(m => m.id !== msgId);
      saveHistory(); 
      rebuildChatUI(localChatHistory); 
      console.log(`💥 Message ${msgId} destroyed!`);
  }, delay); 
}

async function saveHistory() {
  if (!currentPin || !cryptoKey) return;
  try {
      const encryptedData = await encryptData(localChatHistory, cryptoKey);
      localStorage.setItem(`bchat_history_${currentPin}`, encryptedData);
  } catch (error) {
      console.error("Failed to encrypt local history:", error);
  }
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
        } else {
            localChatHistory = [];
        }
    } catch (e) { 
        console.warn("Could not decrypt history. Starting fresh.");
        localChatHistory = []; 
    }
  } else { 
      localChatHistory = []; 
  }
}

// --- Push Notifications ---
function setupPushIdentity() {
    if (window.OneSignalDeferred) {
        window.OneSignalDeferred.push(function(OneSignal) {
            const broadcastId = (id) => {
                if (!id) return;
                const pushTopic = `blackchat/users/${currentTopic}/push_id`;
                const payload = JSON.stringify({ pushId: id, mqttId: MY_CLIENT_ID });
                const message = new Paho.MQTT.Message(payload);
                message.destinationName = pushTopic;
                message.retained = true;
                queueOrSend(message, false);
            };
            const currentId = OneSignal.User.PushSubscription.id;
            if (currentId) broadcastId(currentId);

            OneSignal.User.PushSubscription.addEventListener("change", function(event) {
                if (event.current.id) broadcastId(event.current.id);
            });
            OneSignal.Slidedown.promptPush();
        });
    }
}

async function sendPushNotification(targetId, text) {
    const BACKEND_URL = "secure-room-proxy.mark-fili25.workers.dev"; 

    const displayPin = currentPin.substring(0, 4) + "*";

    try {
        await fetch(BACKEND_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                targetId: targetId,
                pin: displayPin
            })
        });
        console.log("Push notification requested securely.");
    } catch (error) {
        console.error("Failed to communicate with push proxy:", error);
    }
}

// --- Connection Handlers ---
async function connectByPin() {
  const pin = document.getElementById('pin_input').value.trim();
  if (!pin) return;

  if (pin.length < 8) {
      alert("SECURITY ALERT: Passphrase must be at least 8 characters long.");
      return;
  }

  currentPin = pin;
  currentTopic = await hashPinForTopic(pin);
  
  cryptoKey = await deriveKey(pin);

  await loadHistory(currentPin);
  rebuildChatUI(localChatHistory);
  showScreen('chat-screen');
  setConnectionStatus(false, currentPin.substring(0, 4) + "*", "Connecting to Cloud...");

  client = new Paho.MQTT.Client(BROKER_URL, BROKER_PORT, MY_CLIENT_ID);
  
  client.onConnectionLost = onConnectionLost;
  client.onMessageArrived = onMessageArrived;

  client.connect({
    useSSL: true, cleanSession: false, keepAliveInterval: 30, timeout: 3,
    onSuccess: onConnect,
    onFailure: (err) => {
      setConnectionStatus(false, currentPin.substring(0, 4) + "*", "Connection Error");
      alert("Unable to connect to server.");
    }
  });
}

function onConnect() {
  setConnectionStatus(true, currentPin.substring(0, 4) + "*", "Online");
  client.subscribe(`blackchat/room/${currentTopic}`, { qos: 1 });
  client.subscribe(`blackchat/users/${currentTopic}/push_id`, { qos: 1 });
  setupPushIdentity(); 

  if (offlineQueue.length > 0) {
      console.log(`Sending ${offlineQueue.length} queued messages...`);
      while(offlineQueue.length > 0) {
          const item = offlineQueue.shift();
          client.send(item.msg);
          if (item.push && peerPushId) sendPushNotification(peerPushId, "New Secure Message");
      }
  }
}

function reconnect() {
    if (!currentPin || !client || client.isConnected() || isReconnecting) return;
    
    isReconnecting = true;
    setConnectionStatus(false, currentPin.substring(0, 4) + "*", "Reconnecting...");
    console.log("Reconnection attempt in progress...");

    client.connect({
        useSSL: true, 
        cleanSession: false, 
        keepAliveInterval: 30, 
        timeout: 3,
        onSuccess: () => {
            isReconnecting = false;
            console.log("Reconnected successfully!");
            onConnect(); 
        },
        onFailure: (err) => {
            isReconnecting = false;
            console.log("Reconnection failed, retrying in 3 seconds...", err);
            setTimeout(reconnect, 3000); 
        }
    });
}

function onConnectionLost(responseObject) {
  setConnectionStatus(false, currentPin.substring(0, 4) + "*", `Disconnected`);
  if (responseObject.errorCode !== 0 && currentPin) {
    console.log("Connection lost: " + responseObject.errorMessage);
    setTimeout(reconnect, 1000);
  }
}

function disconnect() {
  isReconnecting = false;
  offlineQueue = []; 
  if (client) { try { client.disconnect(); } catch(e){} }
  client = null; cryptoKey = null; currentPin = "";
  document.getElementById('pin_input').value = '';
  showScreen('login-screen');
}

// --- Message Handlers ---
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
      rebuildChatUI(localChatHistory);
      console.log("💀 Room wiped");
      return;
  }

  if ((data.type === 'MSG' || data.type === 'IMG' || data.type === 'LOC' || data.type === 'DOC') && !messageExists(data.id)) {
      let msgType = 'text';
      if (data.type === 'IMG') msgType = 'image';
      if (data.type === 'LOC') msgType = 'location';
      if (data.type === 'DOC') msgType = 'document'; 
      
      const msgObj = { 
        id: data.id, 
        sender: 'peer', 
        text: data.text, 
        time: Date.now(), 
        isBomb: data.isBomb, 
        msgType: msgType,
        fileName: data.fileName || (msgType === 'location' ? 'location.gps' : (msgType === 'document' ? 'document.pdf' : 'image.jpg'))
      };
      
      localChatHistory.push(msgObj);
      saveHistory();
      addMessageToUI(msgObj.text, 'peer', data.isBomb, msgObj.msgType, msgObj.fileName);
      playNotificationSound();
      
      if (data.isBomb) {
          startAutodestructTimer(data.id);
      }
  }
}

async function sendMessage() {
  const input = document.getElementById('message_input');
  const text = input.value.trim();
  const attachIcon = document.querySelector('#attach-btn ion-icon');
  const isBombActive = attachIcon.getAttribute('name') === 'radio-button-on';
  
  if (!text) return;

  if (text === `exit`) { input.value = ''; disconnect(); return; }
  if (text === `clear`) { localChatHistory = []; localStorage.removeItem(`bchat_history_${currentPin}`); document.getElementById("chat-messages").innerHTML = ''; input.value = ''; return; }

  if (text === `wipe`) { 
      localChatHistory = []; 
      localStorage.removeItem(`bchat_history_${currentPin}`); 
      rebuildChatUI(localChatHistory);

      const payloadObj = { type: 'WIPE', senderId: MY_CLIENT_ID };
      const encrypted = await encryptData(payloadObj, cryptoKey);
      const message = new Paho.MQTT.Message(encrypted);
      message.destinationName = `blackchat/room/${currentTopic}`;
      message.qos = 1; message.retained = true; 
      queueOrSend(message, false);
      
      input.value = ''; 
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
  
  input.value = '';
  attachIcon.setAttribute('name', 'add');
  attachIcon.style.color = ''; 
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
          const isBombActive = attachIcon.getAttribute('name') === 'radio-button-on';

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
          
          document.getElementById('attachment-panel').classList.remove('open');
          if (isBombActive) startAutodestructTimer(msgId);
          
          e.target.value = ''; 
      }
      img.src = event.target.result;
  }
  reader.readAsDataURL(file);
}

// --- Event Listeners ---
window.connectByPin = connectByPin;
window.sendMessage = sendMessage;

document.getElementById('message_input').addEventListener('click',scrollToBottom);
document.getElementById('message_input').addEventListener('focus',scrollToBottom);

document.getElementById('connect-btn').addEventListener('click', connectByPin);
document.getElementById('pin_input').addEventListener('keydown', function(event) {
  if (event.key==='Enter') connectByPin();
});

document.getElementById('send-btn').addEventListener('click', sendMessage);
document.getElementById('message_input').addEventListener('keydown', function(event) {
  if (event.key==='Enter') sendMessage();
});

let isPrivacyMode = localStorage.getItem('secure_room_privacy') === 'true';
applyPrivacyMode(isPrivacyMode);

const chatHeader = document.querySelector('.chat-header');
chatHeader.addEventListener('click', function(e) {
  if (e.target.classList.contains('header-lock') || e.target.closest('.header-lock')) {
    isPrivacyMode = !isPrivacyMode; 
    localStorage.setItem('secure_room_privacy', isPrivacyMode); 
    applyPrivacyMode(isPrivacyMode); 
  }
});
chatHeader.addEventListener('dblclick', function(e) {
  if (e.target.classList.contains('header-lock') || e.target.closest('.header-lock')) return;
  if (currentPin) { disconnect(); console.log("🚪 Panic Door Triggered"); }
});

window.addEventListener('popstate', (event) => {
  if (document.getElementById('chat-screen').classList.contains('active')) {
    event.preventDefault(); disconnect(); 
  }
});

document.getElementById('message_input').addEventListener('input', function() {
  const panel = document.getElementById('attachment-panel');
  if (panel) panel.classList.remove('open'); 
  
  const attachIcon = document.querySelector('#attach-btn ion-icon');
  const currentIcon = attachIcon.getAttribute('name');
  if (this.value.trim().length > 0) {
    if (currentIcon === 'add') attachIcon.setAttribute('name', 'radio-button-off');
  } else {
    attachIcon.setAttribute('name', 'add'); 
    attachIcon.style.color = ''; 
  }
});

document.addEventListener('click', function(event) {
  const panel = document.getElementById('attachment-panel');
  const attachBtn = document.getElementById('attach-btn');
  if (panel && panel.classList.contains('open')) {
    if (!panel.contains(event.target) && !attachBtn.contains(event.target)) {
      panel.classList.remove('open');
    }
  }
});

document.getElementById('attach-btn').addEventListener('click', function() {
  const attachIcon = document.querySelector('#attach-btn ion-icon');
  const currentIcon = attachIcon.getAttribute('name');
  const panel = document.getElementById('attachment-panel');
  
  if (currentIcon === 'add') {
    panel.classList.toggle('open');
  } else if (currentIcon === 'radio-button-off') {
    attachIcon.setAttribute('name', 'radio-button-on');
    attachIcon.style.color = 'var(--danger)';
  } else if (currentIcon === 'radio-button-on') {
    attachIcon.setAttribute('name', 'radio-button-off');
    attachIcon.style.color = ''; 
  }
});

const attachBtn = document.getElementById('attach-btn');
const sendBtn = document.getElementById('send-btn');

attachBtn.addEventListener('mousedown', keepKeyboardOpen);
attachBtn.addEventListener('touchstart', keepKeyboardOpen, { passive: false });
sendBtn.addEventListener('mousedown', keepKeyboardOpen);
sendBtn.addEventListener('touchstart', keepKeyboardOpen, { passive: false });

document.getElementById('btn-gallery').addEventListener('click', function() {
  document.getElementById('image_input_gallery').click();
});
document.getElementById('btn-camera').addEventListener('click', function() {
  document.getElementById('image_input_camera').click();
});

document.getElementById('image_input_gallery').addEventListener('change', processAndSendImage);
document.getElementById('image_input_camera').addEventListener('change', processAndSendImage);

document.getElementById('close-viewer-btn').addEventListener('click', function() {
  closeImageViewer();
});

document.getElementById('btn-location').addEventListener('click', function() {
  if (!navigator.geolocation) {
      alert("Geolocation is not supported by your browser.");
      return;
  }

  const attachIcon = document.querySelector('#attach-btn ion-icon');
  const isBombActive = attachIcon.getAttribute('name') === 'radio-button-on';

  navigator.geolocation.getCurrentPosition(async (position) => {
      const lat = position.coords.latitude;
      const lon = position.coords.longitude;
      
      const mapsUrl = `https://www.google.com/maps?q=$${lat},${lon}`;
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

      document.getElementById('attachment-panel').classList.remove('open');
      if (isBombActive) startAutodestructTimer(msgId);

  }, (error) => {
      alert("Access Denied");
  });
});

document.getElementById('btn-document').addEventListener('click', function() {
  document.getElementById('doc_input').click();
});

document.getElementById('doc_input').addEventListener('change', function(e) {
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
  const isBombActive = attachIcon.getAttribute('name') === 'radio-button-on';

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

      document.getElementById('attachment-panel').classList.remove('open');
      if (isBombActive) startAutodestructTimer(msgId);
      
      e.target.value = ''; 
  };
  
  reader.readAsDataURL(file); 
});

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && currentPin) {
        if (client && !client.isConnected()) {
            console.log("App returned to foreground, forcing reconnection...");
            reconnect();
        }
    }
});

window.addEventListener("online", () => {
    if (currentPin && client && !client.isConnected()) {
        console.log("Internet connection restored, forcing reconnection...");
        reconnect();
    }
});

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
        isPrivacyMode = true;
        localStorage.setItem('secure_room_privacy', 'true');
        applyPrivacyMode(true);
        console.log("App moved to background: Privacy Mode auto-enabled.");
    }
    else if (document.visibilityState === "visible" && currentPin) {
        if (client && !client.isConnected()) {
            console.log("App returned to foreground, forcing reconnection...");
            reconnect();
        }
    }
});