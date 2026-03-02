import { hashPinForTopic, deriveKey, encryptData, decryptData } from './crypto.js';
import { scrollToBottom, showScreen, setConnectionStatus, addMessageToUI,
rebuildChatUI, playNotificationSound, applyPrivacyMode, closeImageViewer } from './ui.js';

let client = null;
let cryptoKey = null;
let localChatHistory = []; 
let currentPin = ""; 
let currentTopic = "";
let peerPushId = null; 

let storedClientId = localStorage.getItem("mqtt_client_id");
if (!storedClientId) {
  storedClientId = "bc_user_" + Date.now() + "_" + Math.random().toString(16).substr(2, 8);
  localStorage.setItem("mqtt_client_id", storedClientId);
}
const MY_CLIENT_ID = storedClientId;

const BROKER_URL = "broker.emqx.io"; 
const BROKER_PORT = 8084; 

const ONESIGNAL_APP_ID = "fbcbc6a0-8e00-4bd6-b389-c2fc6676ece2";
const KEY_PART_ONE = "os_v2_app_7pf4nieoabf5nm4jyl6gm5xm4khjeftawmeujg4bcc";
const KEY_PART_TWO = "iajbzlrtt5czv2ab6cpqovmyhoacgaxesmfqiosacee7kvjim3ieoy7d2no5i";
const ONESIGNAL_API_KEY = KEY_PART_ONE + KEY_PART_TWO; 


function loadHistory(pin) {
  const saved = localStorage.getItem(`bchat_history_${pin}`);
  if (saved) {
    try { localChatHistory = JSON.parse(saved); } catch (e) { localChatHistory = []; }
  } else { localChatHistory = []; }
}

function saveHistory() {
  if (!currentPin) return;
  localStorage.setItem(`bchat_history_${currentPin}`, JSON.stringify(localChatHistory));
}

function messageExists(id) {
  return localChatHistory.some(m => m.id === id);
}


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
                if (client && client.isConnected()) {
                     client.send(message);
                }
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

function sendPushNotification(targetId, text) {
    const headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": "Basic " + ONESIGNAL_API_KEY
    };
    const data = {
        app_id: ONESIGNAL_APP_ID,
        include_player_ids: [targetId],
        headings: { "en": `Secure Room ${currentPin}` },
        contents: { "en": `New Secure Message` }, 
        url: "https://secure-room.me" 
    };
    fetch("https://onesignal.com/api/v1/notifications", {
        method: "POST", headers: headers, body: JSON.stringify(data)
    });
}

async function connectByPin() {
  const pin = document.getElementById('pin_input').value.trim();
  if (!pin) return;

  currentPin = pin;
  currentTopic = await hashPinForTopic(pin);

  loadHistory(currentPin);
  rebuildChatUI(localChatHistory);
  showScreen('chat-screen');
  setConnectionStatus(false, currentPin, "Connecting to Cloud...");

  cryptoKey = await deriveKey(pin);
  client = new Paho.MQTT.Client(BROKER_URL, BROKER_PORT, MY_CLIENT_ID);
  
  client.onConnectionLost = onConnectionLost;
  client.onMessageArrived = onMessageArrived;

  client.connect({
    useSSL: true, cleanSession: false, keepAliveInterval: 30, timeout: 3,
    onSuccess: onConnect,
    onFailure: (err) => {
      setConnectionStatus(false, currentPin, "Connection Error");
      alert("Unable to connect to server.");
    }
  });
}

function onConnect() {
  setConnectionStatus(true, currentPin, "Online");
  client.subscribe(`blackchat/room/${currentTopic}`, { qos: 1 });
  client.subscribe(`blackchat/users/${currentTopic}/push_id`, { qos: 1 });
  setupPushIdentity(); 
}

function onConnectionLost(responseObject) {
  setConnectionStatus(false,currentPin, `Disconnected from ${currentPin}`);
  setTimeout(() => {
    document.getElementById("status-text").innerText =`Connection Deletion.`;
  },1700);
  setTimeout(() => {
    document.getElementById("status-text").innerText =`Connection Deletion..`;
  },1800);
  setTimeout(() => {
    document.getElementById("status-text").innerText =`Connection Deletion..`;
  },1900);
  setTimeout(() => {
    document.getElementById("status-text").innerText ='';
  },2000);
  if (responseObject.errorCode !== 0) {
    console.log("Connection lost: " + responseObject.errorMessage);
    setTimeout(() => {
        if(currentPin) {
            console.log("Reconnecting...");
            client.connect({onSuccess: onConnect, useSSL: true, cleanSession: false});
        }
    }, 2000);
  }
}


function startAutodestructTimer(msgId) {
  setTimeout(() => {
      localChatHistory = localChatHistory.filter(m => m.id !== msgId);
      saveHistory(); 
      rebuildChatUI(localChatHistory); 
      console.log(`💥 Messaggio ${msgId} autodistrutto!`);
  }, 10000); 
}

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

  if ((data.type === 'MSG' || data.type === 'IMG') && !messageExists(data.id)) {

      const isImage = data.type === 'IMG';
      
      const msgObj = { 
        id: data.id, 
        sender: 'peer', 
        text: data.text, 
        time: Date.now(), 
        isBomb: data.isBomb, 
        msgType: isImage ? 'image' : 'text',
        fileName: data.fileName || 'secure_image.jpg'
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
  
  if (text) {
    if (text === `exit`) { input.value = ''; disconnect(); return; }
    if (text === `clear`) { localChatHistory = []; localStorage.removeItem(`bchat_history_${currentPin}`); document.getElementById("chat-messages").innerHTML = ''; input.value = ''; return; }

    const msgId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    
    const msgObj = { id: msgId, sender: 'me', text: text, time: Date.now(), isBomb: isBombActive };
    localChatHistory.push(msgObj);
    saveHistory();
    addMessageToUI(text, 'me', isBombActive);
    
    if (client && client.isConnected()) {
      const payloadObj = { type: 'MSG', text: text, id: msgId, senderId: MY_CLIENT_ID, isBomb: isBombActive };
      const encrypted = await encryptData(payloadObj, cryptoKey);
      const message = new Paho.MQTT.Message(encrypted);
      message.destinationName = `blackchat/room/${currentTopic}`;
      message.qos = 1; message.retained = true; 
      client.send(message);
      if (peerPushId) sendPushNotification(peerPushId, "New Secure Message");
    } else {
      alert("You are offline.");
    }
    input.value = '';
    
    attachIcon.setAttribute('name', 'add');
    attachIcon.style.color = ''; 
    
    if (isBombActive) {
        startAutodestructTimer(msgId);
    }
  }
}

function disconnect() {
  if (client) { try { client.disconnect(); } catch(e){} }
  client = null; cryptoKey = null; currentPin = "";
  document.getElementById('pin_input').value = '';
  showScreen('login-screen');
}

window.connectByPin = connectByPin;
window.sendMessage = sendMessage;

document.getElementById('message_input').addEventListener('click',scrollToBottom);
document.getElementById('message_input').addEventListener('focus',scrollToBottom);

document.getElementById('connect-btn').addEventListener('click', connectByPin);
document.getElementById('pin_input').addEventListener('keydown', function(event) {
  if (event.key==='Enter') {
    connectByPin();
  }
});

document.getElementById('send-btn').addEventListener('click', sendMessage);
document.getElementById('message_input').addEventListener('keydown', function(event) {
  if (event.key==='Enter') {
    sendMessage();
  }
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
  
  if (currentPin) {
    disconnect();
    console.log("🚪 Panic Door");
  }
});

window.addEventListener('popstate', (event) => {
  if (document.getElementById('chat-screen').classList.contains('active')) {
    event.preventDefault(); disconnect(); 
  }
});

document.getElementById('message_input').addEventListener('input', function() {
  const attachIcon = document.querySelector('#attach-btn ion-icon');
  const currentIcon = attachIcon.getAttribute('name');
  
  if (panel) panel.classList.remove('open');
  
  if (this.value.trim().length > 0) {
    if (currentIcon === 'add') {
      attachIcon.setAttribute('name', 'radio-button-off');
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
      panel.classList.remove('open');
    }
  }
});

document.getElementById('attach-btn').addEventListener('click', function() {
  const attachIcon = document.querySelector('#attach-btn ion-icon');
  const currentIcon = document.querySelector('#attach-btn ion-icon').getAttribute('name');
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



document.getElementById('btn-send-photo').addEventListener('click', function() {
  document.getElementById('image_input').click();
});

document.getElementById('image_input').addEventListener('change', function(e) {
  const file = e.target.files[0];
  if (!file) return;
  
  const originalFileName = file.name; // CATTURIAMO IL NOME DEL FILE!

  const reader = new FileReader();
  reader.onload = function(event) {
      const img = new Image();
      img.onload = async function() {
          const canvas = document.createElement('canvas');
          const MAX_WIDTH = 800; 
          const MAX_HEIGHT = 800;
          let width = img.width;
          let height = img.height;

          if (width > height) {
              if (width > MAX_WIDTH) { height *= MAX_WIDTH / width; width = MAX_WIDTH; }
          } else {
              if (height > MAX_HEIGHT) { width *= MAX_HEIGHT / height; height = MAX_HEIGHT; }
          }
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);

          const base64Img = canvas.toDataURL('image/jpeg', 0.6);
          const msgId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
          const attachIcon = document.querySelector('#attach-btn ion-icon');
          const isBombActive = attachIcon.getAttribute('name') === 'radio-button-on';

          // SALVIAMO IL NOME DEL FILE IN MEMORIA
          const msgObj = { id: msgId, sender: 'me', text: base64Img, time: Date.now(), isBomb: isBombActive, msgType: 'image', fileName: originalFileName };
          localChatHistory.push(msgObj);
          saveHistory();
          addMessageToUI(base64Img, 'me', isBombActive, 'image', originalFileName);

          // INVIAMO IL NOME DEL FILE AL SERVER
          if (client && client.isConnected()) {
              const payloadObj = { type: 'IMG', text: base64Img, id: msgId, senderId: MY_CLIENT_ID, isBomb: isBombActive, fileName: originalFileName };
              const encrypted = await encryptData(payloadObj, cryptoKey);
              const message = new Paho.MQTT.Message(encrypted);
              message.destinationName = `blackchat/room/${currentTopic}`;
              message.qos = 1; message.retained = true; 
              client.send(message);
          }
          
          document.getElementById('attachment-panel').classList.remove('open');
          if (isBombActive) startAutodestructTimer(msgId);
          document.getElementById('image_input').value = '';
      }
      img.src = event.target.result;
  }
  reader.readAsDataURL(file);
});

// Bottone indietro del visualizzatore
document.getElementById('close-viewer-btn').addEventListener('click', function() {
  closeImageViewer();
});