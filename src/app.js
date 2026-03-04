import { hashPinForTopic, deriveKey, encryptData, decryptData } from './crypto.js';
import { scrollToBottom, showScreen, setConnectionStatus, addMessageToUI,
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
let isPrivacyMode = false;

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
    const BACKEND_URL = "https://secure-room-proxy.mark-fili25.workers.dev"; 
    const displayPin = currentPin.substring(0, 4) + "***";

    try {
        await fetch(BACKEND_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ targetId: targetId, pin: displayPin })
        });
    } catch (error) {}
}

// --- Connection Handlers ---
async function connectByPin() {
  const pin = document.getElementById('pin_input').value.trim();
  if (!pin) return;

  if (pin.length < 8) {
      const connectBtn = document.getElementById('connect-btn');
      const loginStatus = document.getElementById('status-text');

      if (loginStatus) {
          loginStatus.innerText = "SECURITY ALERT: Passphrase must be at least 8 characters long.";
      }

      if (connectBtn) {
          connectBtn.classList.remove('shake-error'); 
          void connectBtn.offsetWidth; 
          connectBtn.classList.add('shake-error');
          
          setTimeout(() => {
              connectBtn.classList.remove('shake-error');
          }, 400);
      }
      return;
  }

  currentPin = pin;
  currentTopic = await hashPinForTopic(pin);
  cryptoKey = await deriveKey(pin);

  await loadHistory(currentPin);
  rebuildChatUI(localChatHistory);

  const chatScreen = document.getElementById('chat-screen');
  chatScreen.classList.remove('chat-focus-in'); // Pulisce memorie di vecchie animazioni
  void chatScreen.offsetWidth; // Trucco JS per riavviare l'animazione da zero
  chatScreen.classList.add('chat-focus-in');

  showScreen('chat-screen');
  setConnectionStatus(false, currentPin.substring(0, 4) + "***", "Connecting to Cloud...");

  client = new Paho.MQTT.Client(BROKER_URL, BROKER_PORT, MY_CLIENT_ID);
  client.onConnectionLost = onConnectionLost;
  client.onMessageArrived = onMessageArrived;

  client.connect({
    useSSL: true, cleanSession: false, keepAliveInterval: 30, timeout: 3,
    onSuccess: onConnect,
    onFailure: (err) => {
      setConnectionStatus(false, currentPin.substring(0, 4) + "***", "Connection Error");
      alert("Unable to connect to server.");
    }
  });
}

function onConnect() {
  setConnectionStatus(true, currentPin.substring(0, 4) + "***", "Online");
  client.subscribe(`blackchat/room/${currentTopic}`, { qos: 1 });
  client.subscribe(`blackchat/users/${currentTopic}/push_id`, { qos: 1 });
  setupPushIdentity();

  if (offlineQueue.length > 0) {
      let needsPush = false;
      while(offlineQueue.length > 0) {
          const item = offlineQueue.shift();
          client.send(item.msg);
          if (item.push) needsPush = true;
      }
      
      if (needsPush && peerPushId) sendPushNotification(peerPushId, "New Secure Message");
  }
}

function reconnect() {
    if (!currentPin || !client || client.isConnected() || isReconnecting) return;
    
    isReconnecting = true;
    setConnectionStatus(false, currentPin.substring(0, 4) + "***", "Reconnecting...");

    client.connect({
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
  setConnectionStatus(false, currentPin.substring(0, 4) + "***", `Disconnected`);
  if (responseObject.errorCode !== 0 && currentPin) {
    setTimeout(reconnect, 1000);
  }
}

function disconnect() {
  isReconnecting = false;
  offlineQueue = []; 
  if (client) { try { client.disconnect(); } catch(e){} }
  client = null; cryptoKey = null; currentPin = "";
  
  document.getElementById('pin_input').value = '';
  resetInputState();

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

  showScreen('login-screen');
  document.getElementById('chat-screen').classList.remove('chat-focus-in');
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
      document.getElementById("chat-messages").innerHTML = ''; 
      resetInputState(); 
      return; 
  }

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

function handleGallery(e) {
  if (e) { e.preventDefault(); animateButton(e.currentTarget); }
  setTimeout(() => { closeAttachmentPanel(); document.getElementById('image_input_gallery').click(); }, 150);
}

function handleCamera(e) {
  if (e) { e.preventDefault(); animateButton(e.currentTarget); }
  setTimeout(() => { closeAttachmentPanel(); document.getElementById('image_input_camera').click(); }, 150);
}

function handleDocument(e) {
  if (e) { e.preventDefault(); animateButton(e.currentTarget); }
  setTimeout(() => { closeAttachmentPanel(); document.getElementById('doc_input').click(); }, 150);
}

function handleLocation(e) {
  if (e) { e.preventDefault(); animateButton(e.currentTarget); }
  closeAttachmentPanel();

  if (!navigator.geolocation) {
      alert("Geolocation is not supported by your browser.");
      return;
  }

  const attachIcon = document.querySelector('#attach-btn ion-icon');
  const panelIcon = document.querySelector('#panel-bomb-icon');
  const isBombActive = (attachIcon && attachIcon.getAttribute('name') === 'radio-button-on') || 
                       (panelIcon && panelIcon.getAttribute('name') === 'radio-button-on');

  navigator.geolocation.getCurrentPosition(async (position) => {
      const lat = position.coords.latitude;
      const lon = position.coords.longitude;
      
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

  }, (error) => {
      alert("Access Denied");
  });
}

window.connectByPin = connectByPin;
window.sendMessage = sendMessage;

document.getElementById('message_input').addEventListener('click',scrollToBottom);
document.getElementById('message_input').addEventListener('focus',scrollToBottom);

document.getElementById('connect-btn').addEventListener('click', connectByPin);
document.getElementById('pin_input').addEventListener('keydown', function(event) {
  if (event.key==='Enter') connectByPin();
});

document.getElementById('message_input').addEventListener('keydown', function(event) {
  if (event.key==='Enter') sendMessage();
});


applyPrivacyMode(isPrivacyMode);

const chatHeader = document.querySelector('.chat-header');
let lastTapTime = 0;

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

window.addEventListener('popstate', (event) => {
  if (document.getElementById('chat-screen').classList.contains('active')) {
    event.preventDefault(); disconnect(); 
  }
});

document.getElementById('message_input').addEventListener('input', function() {
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

document.addEventListener('click', function(event) {
  const panel = document.getElementById('attachment-panel');
  const attachBtn = document.getElementById('attach-btn');
  if (panel && panel.classList.contains('open')) {
    if (!panel.contains(event.target) && !attachBtn.contains(event.target)) {
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

sendBtn.addEventListener('mousedown', handleSend);
sendBtn.addEventListener('touchstart', handleSend, { passive: false });

attachBtn.addEventListener('mousedown', handleAttach);
attachBtn.addEventListener('touchstart', handleAttach, { passive: false });

if (btnPanelBomb) {
    btnPanelBomb.addEventListener('mousedown', handlePanelBomb);
    btnPanelBomb.addEventListener('touchstart', handlePanelBomb, { passive: false });
}

btnGallery.addEventListener('mousedown', handleGallery);
btnGallery.addEventListener('touchstart', handleGallery, { passive: false });

btnCamera.addEventListener('mousedown', handleCamera);
btnCamera.addEventListener('touchstart', handleCamera, { passive: false });

btnLocation.addEventListener('mousedown', handleLocation);
btnLocation.addEventListener('touchstart', handleLocation, { passive: false });

btnDocument.addEventListener('mousedown', handleDocument);
btnDocument.addEventListener('touchstart', handleDocument, { passive: false });

document.getElementById('image_input_gallery').addEventListener('change', processAndSendImage);
document.getElementById('image_input_camera').addEventListener('change', processAndSendImage);

document.getElementById('close-viewer-btn').addEventListener('click', function() {
  closeImageViewer();
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


document.getElementById('pin_input').addEventListener('input', function() {
    const loginStatus = document.getElementById('status-text');
    if (loginStatus) loginStatus.innerText = "";
});

window.addEventListener("online", () => {
    if (currentPin && client && !client.isConnected()) {
        reconnect();
    }
});

window.addEventListener('load', () => {
    const overlay = document.getElementById('transition-overlay');
    setTimeout(() => {
        overlay.classList.remove('active');
    }, 1500);

});