# ☁️ MQTT Secure Chat

> A robust, "Offline-First" encrypted chat application.
> Powered by MQTT for reliable message delivery and the Web Crypto API for military-grade security.

![Status](https://img.shields.io/badge/Status-Active-success.svg)
![Protocol](https://img.shields.io/badge/Protocol-MQTT%20over%20WSS-blue.svg)
![Security](https://img.shields.io/badge/Security-AES--GCM%20E2EE-red.svg)

## 🚀 The Upgrade
Unlike traditional P2P chats (WebRTC) that require both users to be online simultaneously, this application uses a **Store-and-Forward** architecture.
You can send messages while the recipient is offline. They will receive and decrypt them the moment they reconnect.

## ✨ Key Features
* **Async Messaging:** Send messages anytime. If the recipient is away, the cloud holds the encrypted packet until they return.
* **End-to-End Encryption (E2EE):** Messages are encrypted locally using **AES-GCM 256-bit** before they ever touch the network. The MQTT broker only sees scrambled data.
* **Zero-Knowledge Architecture:** The public broker acts as a blind postman. It delivers the mail but cannot read it (it doesn't have your PIN/Key).
* **Persistent History:** Chats are securely stored in your browser's `localStorage`, so you never lose context even if you close the tab.
* **Cross-Device:** Works flawlessly between Desktop and Mobile (Android/iOS) via a responsive Web Interface.

## 🛠️ Tech Stack
* **Core:** Vanilla JavaScript (ES6+).
* **Networking:** MQTT over WebSockets (via `Paho MQTT Client`).
* **Security:** Native `window.crypto.subtle` API.
* **Infrastructure:** Connects to any standard MQTT Broker (default: `broker.emqx.io`).

## 🚀 How to Run
1.  Clone the repository.
2.  Open `index.html` in any modern browser (or serve it via VS Code Live Server).
3.  Enter a **PIN** (e.g., `1234`) to join a room.
4.  Share the PIN with a friend.
5.  Start chatting!

## 🔒 Security Notice
While the message content is fully encrypted (E2EE), metadata (like the topic name based on your PIN) passes through a public MQTT broker.
* **Content:** Secure (Invisible to the broker).
* **Metadata:** Visible (The broker knows *someone* is writing to room `1234`).
* *Recommendation:* Use complex PINs for better privacy.

## 👨‍💻 Author
**Kcisti**