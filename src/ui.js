export function scrollToBottom() {
  const chat = document.getElementById("chat-messages");
  setTimeout(() => {
    chat.scrollTop = chat.scrollHeight;
  }, 200);
  
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
  headerTitle.innerHTML = `DeepWire Room ${currentPin} <ion-icon name="lock-closed" 
  class="header-lock"></ion-icon><span style="color:${color};margin-left: 0.5rem;
  ">●</span>`;
  document.getElementById("status-text").innerText = text;
}

export function addMessageToUI(content, sender, isBomb = false, msgType = 'text', fileName = 'image.jpg') {
  scrollToBottom();
  const chat = document.getElementById("chat-messages");
  const wrapper = document.createElement('div');
  wrapper.className = `msg-wrapper ${sender}`;
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  if (msgType === 'image') {
    const fileDiv = document.createElement('div');
    fileDiv.className = 'file-attachment';
    fileDiv.innerHTML = `<ion-icon name="image"></ion-icon> <span>${fileName}</span>`;

    fileDiv.onclick = () => openImageViewer(content, fileName);
    
    bubble.appendChild(fileDiv);
    
    if (isBomb) {
      const icon = document.createElement('ion-icon');
      icon.setAttribute('name', 'time');
      icon.className = 'bomb-icon bomb-icon-img';
      bubble.appendChild(icon);
    }
  } else if (msgType === 'location') {
    const fileDiv = document.createElement('div');
    fileDiv.className = 'file-attachment';
   
    fileDiv.innerHTML = `<ion-icon name="location"></ion-icon> <span>${fileName}</span>`;
    fileDiv.onclick = () => window.open(content, '_blank');
    bubble.appendChild(fileDiv);
    
    if (isBomb) {
      const icon = document.createElement('ion-icon');
      icon.setAttribute('name', 'time');
      icon.className = 'bomb-icon bomb-icon-img';
      bubble.appendChild(icon);
    }
  } else if (msgType === 'document') {
    const fileDiv = document.createElement('div');
    fileDiv.className = 'file-attachment';

    fileDiv.innerHTML = `<ion-icon name="document-text-outline"></ion-icon> <span>${fileName}</span>`;
    
    fileDiv.onclick = () => {
        const downloadLink = document.createElement('a');
        downloadLink.href = content; 
        downloadLink.download = fileName;
        document.body.appendChild(downloadLink);
        downloadLink.click();
        document.body.removeChild(downloadLink);
    };
    bubble.appendChild(fileDiv);
  } 
  else if (msgType === 'audio') {
    const audioEl = document.createElement('audio');
    audioEl.src = content; 
    audioEl.preload = 'auto';

    const playerContainer = document.createElement('div');
    playerContainer.className = 'custom-audio-player';
    
    playerContainer.innerHTML = `
        <button class="audio-play-pause">
            <ion-icon name="play"></ion-icon>
        </button>
        <div class="audio-info">
            <div class="audio-progress-container">
                <div class="audio-progress-bar"></div>
            </div>
        </div>
        <span class="audio-time">0:00</span>
    `;

    const playPauseBtn = playerContainer.querySelector('.audio-play-pause');
    const playIcon = playerContainer.querySelector('.audio-play-pause ion-icon');
    const timeDisplay = playerContainer.querySelector('.audio-time');
    const progressBar = playerContainer.querySelector('.audio-progress-bar');

    bubble.appendChild(playerContainer);
    bubble.appendChild(audioEl);

    // --- LOGICA ---
    const formatTime = (seconds) => {
      if (isNaN(seconds) || !isFinite(seconds) || seconds < 0) return "0:00";
      const minutes = Math.floor(seconds / 60);
      const secs = Math.floor(seconds % 60);
      return `${minutes}:${secs < 10 ? '0' : ''}${secs}`;
    };

    let actualDuration = 0;

    // MAGIA: Leggiamo la durata dal nome del file! (es. vocal_5.m4a -> 5)
    if (fileName && fileName.includes('_')) {
        const secExt = fileName.split('_')[1]; // Prende "5.m4a"
        actualDuration = parseFloat(secExt) || 0; // Estrae il 5
    }

    // Appena carica, mostriamo il tempo corretto. Se il file non aveva il tempo nel nome, proviamo a leggerlo normalmente.
    audioEl.addEventListener('loadedmetadata', () => {
        if (actualDuration === 0 && isFinite(audioEl.duration) && audioEl.duration > 0) {
            actualDuration = audioEl.duration;
        }
        if (actualDuration > 0) {
            timeDisplay.textContent = formatTime(actualDuration);
        }
    });

    audioEl.addEventListener('timeupdate', () => {
      const current = audioEl.currentTime;
      
      if (actualDuration > 0) {
          let percentage = (current / actualDuration) * 100;
          if (percentage > 100) percentage = 100;
          progressBar.style.width = `${percentage}%`;
      }
      
      if (current > 0 && !audioEl.paused) {
          timeDisplay.textContent = formatTime(current);
      }
    });

    const togglePlay = () => {
      if (audioEl.paused) {
        document.querySelectorAll('audio').forEach(el => {
          if (el !== audioEl) el.pause();
        });
        
        playIcon.setAttribute('name', 'pause');
        
        audioEl.play().catch(err => {
            playIcon.setAttribute('name', 'play');
            timeDisplay.textContent = "Err";
        });
      } else {
        audioEl.pause();
        playIcon.setAttribute('name', 'play');
      }
    };

    playPauseBtn.addEventListener('click', (e) => {
      e.stopPropagation(); 
      togglePlay();
    });

    playerContainer.addEventListener('click', (e) => {
      if (e.target !== playPauseBtn && !playPauseBtn.contains(e.target)) {
        togglePlay();
      }
    });

    audioEl.addEventListener('ended', () => {
      playIcon.setAttribute('name', 'play');
      progressBar.style.width = '0%';
      // Rimette il testo sulla durata totale
      timeDisplay.textContent = formatTime(actualDuration);
      audioEl.currentTime = 0; // Riavvolge per poterlo riascoltare
    });

    if (isBomb) {
      const icon = document.createElement('ion-icon');
      icon.setAttribute('name', 'time');
      icon.className = 'bomb-icon bomb-icon-img';
      bubble.appendChild(icon);
    }
  }
  
  else {
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
  }
  
  wrapper.appendChild(bubble);
  chat.appendChild(wrapper);

  if (chat.classList.contains('privacy-mode')) {
      bubble.classList.add('revealed');
      bubble.revealTimer = setTimeout(() => {
          bubble.classList.remove('revealed');
          delete bubble.revealTimer;
      }, 5000);
  }

  chat.scrollTop = chat.scrollHeight;
}

export function rebuildChatUI(historyArray) {
  const chat = document.getElementById("chat-messages");
  chat.innerHTML = ''; 
  historyArray.forEach(msg => {
    addMessageToUI(msg.text, msg.sender, msg.isBomb, msg.msgType || 'text', msg.fileName);
  });
  scrollToBottom();
}

export function openImageViewer(base64Data, fileName) {
  document.getElementById('viewer-image').src = base64Data;
  document.getElementById('viewer-filename').innerText = fileName;
  showScreen('viewer-screen');

  const isAutoDownload = localStorage.getItem('bchat_autodownload') === 'true';

  if (isAutoDownload) {
      const downloadBtn = document.getElementById('download-viewer-btn');
      if (downloadBtn) {
          downloadBtn.click(); 
      }
  }
}

export function closeImageViewer() {
  document.getElementById('viewer-image').src = ''; 
  showScreen('chat-screen');
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