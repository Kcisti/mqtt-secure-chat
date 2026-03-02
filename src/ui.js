export function scrollToBottom() {
  const chat = document.getElementById("chat-messages");
  setTimeout(() => {
    chat.scrollTop = chat.scrollHeight;
  }, 500);
  
  const panel = document.getElementById('attachment-panel');
  if (panel && panel.classList.contains('open')) {
    panel.classList.remove('open');
  }
}

export function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');
  if (screenId === 'chat-screen') {
     window.history.pushState({ screen: 'chat' }, "Chat", "#chat");
  }
}

export function setConnectionStatus(isConnected, currentPin, text) {
  const headerTitle = document.querySelector(".header-info h3");
  const color = isConnected ? "var(--primary)" : "var(--danger)";
  headerTitle.innerHTML = `Secure Room ${currentPin} <ion-icon name="lock-closed" 
  class="header-lock"></ion-icon>  (EE2E)  <span style="color:${color}">●</span>`;
  document.getElementById("status-text").innerText = text;
}

export function addMessageToUI(content, sender, isBomb = false, msgType = 'text') {
  scrollToBottom();
  const chat = document.getElementById("chat-messages");
  const wrapper = document.createElement('div');
  wrapper.className = `msg-wrapper ${sender}`;
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';


    if (isBomb) {
      const textSpan = document.createElement('span');
      textSpan.innerText = content;
      const icon = document.createElement('ion-icon');
      icon.setAttribute('name', 'time');
      icon.className = 'bomb-icon';
      bubble.appendChild(textSpan);
      bubble.appendChild(icon);
    } else {
      bubble.innerText = content;
    }
  
  wrapper.appendChild(bubble);
  chat.appendChild(wrapper);
  chat.scrollTop = chat.scrollHeight;
}

export function rebuildChatUI(historyArray) {
  const chat = document.getElementById("chat-messages");
  chat.innerHTML = ''; 
  historyArray.forEach(msg => {
    addMessageToUI(msg.text, msg.sender, msg.isBomb, msg.msgType || 'text');
  });
  scrollToBottom();
}

let lastSoundTime = 0;
export function playNotificationSound() {
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

export function applyPrivacyMode(isActive) {
  const chatContainer = document.getElementById('chat-messages');
  if (isActive) {
    chatContainer.classList.add('privacy-mode');
  } else {
    chatContainer.classList.remove('privacy-mode');
  }
}