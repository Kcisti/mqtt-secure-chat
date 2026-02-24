let client = null;
let cryptoKey = null;
let localChatHistory = []; 
let currentPin = ""; 

let storedClientId = localStorage.getItem("mqtt_client_id");
if (!storedClientId) {
  storedClientId = "bc_user_" + Date.now() + "_" + Math.random().toString(16).substr(2, 8);
  localStorage.setItem("mqtt_client_id", storedClientId);
}
const MY_CLIENT_ID = storedClientId;

const BROKER_URL = "broker.emqx.io"; 
const BROKER_PORT = 8084; 

let lastSoundTime = 0;

function loadHistory(pin) {
  const saved = localStorage.getItem(`bchat_history_${pin}`);
  if (saved) {
    try { localChatHistory = JSON.parse(saved); } catch (e) { localChatHistory = []; }
  } else { localChatHistory = []; }
}

function scrollToBottom() {
  const chat = document.getElementById("chat-messages");
  chat.scrollTop = chat.scrollHeight;
}

function saveHistory() {
  if (!currentPin) return;
  localStorage.setItem(`bchat_history_${currentPin}`, JSON.stringify(localChatHistory));
}

function playNotificationSound() {
  const now = Date.now();
  if (now - lastSoundTime < 1000) return;
  lastSoundTime = now;
  if (navigator.vibrate) navigator.vibrate([300, 100, 150]);
  if (document.hidden) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    gain.gain.setValueAtTime(1, ctx.currentTime);
    gain.gain.setTargetAtTime(0, ctx.currentTime + 0.1, 0.015);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.2);
  } catch (e) {}
}

async function deriveKey(pin) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(pin), { name: "PBKDF2" }, false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: enc.encode("blackchat-salt-secure"), iterations: 100000, hash: "SHA-256" },
    keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
}

async function encryptData(dataObject) {
  const enc = new TextEncoder();
  const jsonString = JSON.stringify(dataObject);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv }, cryptoKey, enc.encode(jsonString)
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return arrayBufferToBase64(combined);
}

async function decryptData(base64String) {
  try {
    const payload = base64ToArrayBuffer(base64String);
    const iv = payload.slice(0, 12);
    const data = payload.slice(12);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv }, cryptoKey, data
    );
    const dec = new TextDecoder();
    return JSON.parse(dec.decode(decrypted));
  } catch (e) { return null; }
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return window.btoa(binary);
}
function base64ToArrayBuffer(base64) {
  const binary_string = window.atob(base64);
  const len = binary_string.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary_string.charCodeAt(i);
  return bytes.buffer;
}

function scrollToBottom() {
  const chat = document.getElementById("chat-messages");
  chat.scrollTop = chat.scrollHeight;
}

function showScreen(screenId) {
  
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');
  if (screenId === 'chat-screen') {
     window.history.pushState({ screen: 'chat' }, "Chat", "#chat");
  }
}

function setConnectionStatus(isConnected, text) {
  const headerTitle = document.querySelector(".header-info h3");
  const color = isConnected ? "var(--primary)" : "var(--danger)";
  headerTitle.innerHTML = `Secure Channel ${currentPin} <ion-icon name="lock-closed" 
  class="header-lock"></ion-icon>  (EE2E)  <span style="color:${color}">●</span>`;
  document.getElementById("status-text").innerText = text;
}

async function connectByPin() {
  const pin = document.getElementById('pin_input').value.trim();
  if (!pin) return;

  currentPin = pin;
  loadHistory(currentPin);
  rebuildChatUI();
  showScreen('chat-screen');
  setConnectionStatus(false, "Connecting to Cloud...");

  cryptoKey = await deriveKey(pin);

  client = new Paho.MQTT.Client(BROKER_URL, BROKER_PORT, MY_CLIENT_ID);
  
  client.onConnectionLost = onConnectionLost;
  client.onMessageArrived = onMessageArrived;

  const options = {
    useSSL: true,
    cleanSession: false, 
    keepAliveInterval: 30,
    timeout: 3,
    onSuccess: onConnect,
    onFailure: (err) => {
      console.log("MQTT Failed", err);
      setConnectionStatus(false, "Connection Error (Retrying)");
      alert("Unable to connect to server.");
    }
  };
  
  client.connect(options);
  scrollToBottom();
}

function onConnect() {
  setConnectionStatus(true, "Online");
  console.log("MQTT Connected");
  
  client.subscribe(`blackchat/room/${currentPin}`, { qos: 1 });
}

function onConnectionLost(responseObject) {
  setConnectionStatus(false, `Disconnected from ${currentPin}`);

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

async function onMessageArrived(message) {
  const encryptedPayload = message.payloadString;
  const data = await decryptData(encryptedPayload);
  
  if (!data || data.senderId === MY_CLIENT_ID) return;

  if (data.type === 'MSG') {
    if (!messageExists(data.id)) {
      const msgObj = { id: data.id, sender: 'peer', text: data.text, time: Date.now() };
      localChatHistory.push(msgObj);
      saveHistory();
      addMessageToUI(msgObj.text, 'peer');
      playNotificationSound();
    }
  }
}

async function sendMessage() {
  const input = document.getElementById('message_input');
  const text = input.value.trim();
  
  if (text) {

    if (text === `exit${currentPin}`) {
      input.value = '';
      disconnect();    
      return;          
    }

    if (text === `clear${currentPin}`) {
      localChatHistory = [];
      localStorage.removeItem(`bchat_history_${currentPin}`);
      
      document.getElementById("chat-messages").innerHTML = '';

      input.value = '';
      
      console.log("Chat history wiped locally.");
      return;
    }

    const msgId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    
    const msgObj = { id: msgId, sender: 'me', text: text, time: Date.now() };
    localChatHistory.push(msgObj);
    saveHistory();
    addMessageToUI(text, 'me');
    
    const payloadObj = {
      type: 'MSG',
      text: text,
      id: msgId,
      senderId: MY_CLIENT_ID
    };
    
    if (client && client.isConnected()) {
      const encrypted = await encryptData(payloadObj);
      const message = new Paho.MQTT.Message(encrypted);
      message.destinationName = `blackchat/room/${currentPin}`;
      
      message.qos = 1;
      message.retained = true; 
      
      client.send(message);
    } else {
      console.log("Offline: Cannot send now.");
      alert("You are offline.");
    }
    
    input.value = '';
  }
}

function messageExists(id) {
  return localChatHistory.some(m => m.id === id);
}

function rebuildChatUI() {
  const chat = document.getElementById("chat-messages");
  chat.innerHTML = ''; 
  localChatHistory.forEach(msg => {
    addMessageToUI(msg.text, msg.sender);
  });

  scrollToBottom();
}

function addMessageToUI(text, sender) {
  scrollToBottom();
  const chat = document.getElementById("chat-messages");
  const wrapper = document.createElement('div');
  wrapper.className = `msg-wrapper ${sender}`;
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.innerText = text;
  wrapper.appendChild(bubble);
  chat.appendChild(wrapper);
  chat.scrollTop = chat.scrollHeight;
}

function disconnect() {
  if (client) {
      try { client.disconnect(); } catch(e){}
  }
  client = null;
  cryptoKey = null;
  currentPin = "";
  document.getElementById('pin_input').value = '';
  showScreen('login-screen');
}

window.addEventListener('popstate', (event) => {
  if (document.getElementById('chat-screen').classList.contains('active')) {
    event.preventDefault(); 
    disconnect(); 
  }
});