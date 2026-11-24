# DaRI AI Arcade & Mobile App

Cross-platform AI Gaming Arcade with Google OAuth 2.0 authentication, Prompt Mirror, Emoji Charades, Code Mirror, Prompt Repair, tournament knockout brackets, and player leaderboards.

---

## 🚀 Quick Start Guide (For Anyone Cloning This Repository)

### 1. Clone the Repository
```bash
git clone https://github.com/NitharshnaAshokkumar/dariai_arcadegame_mobileapp.git
cd dariai_arcadegame_mobileapp
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Create the `.env` File
Create a `.env` file in the project root directory by copying the provided template:

**Windows (PowerShell):**
```powershell
Copy-Item .env.example .env
```

**Mac / Linux / Bash:**
```bash
cp .env.example .env
```

### 4. Configure Your `.env` Values
Open `.env` and fill in your credentials:

```env
PORT=8787
FRONTEND_URL=http://127.0.0.1:8787

# Google OAuth 2.0 Credentials
GOOGLE_CLIENT_ID=your_google_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_google_client_secret

# Session Secret & Admin Configuration
JWT_SECRET=super-secret-jwt-key-for-local-dev
ADMIN_EMAILS=admin@dariai.tech,organizer@dariai.tech
ADMIN_PASSWORD=1234
```

> **Google OAuth Setup Note:**
> In your [Google Cloud Console](https://console.cloud.google.com/) under **APIs & Services > Credentials > OAuth 2.0 Client IDs**:
> - **Authorized JavaScript origins**: `http://127.0.0.1:8787`, `http://localhost:8787`
> - **Authorized redirect URIs**: `http://127.0.0.1:8787/auth/callback`

---

### 5. Start the Application
```bash
npm start
```
Open your browser at **http://127.0.0.1:8787**.

---

## 🎮 Access Modes & Role Assignment
- **🎮 DaRI Participant (Default for all frontend users)**: All users signing in via Google in the frontend are automatically authenticated as DaRI Participants and enter straight into the games arcade to play solo challenges and join tournaments.
- **🛡️ DaRI Admin (Backend Configured)**: Designate administrative emails in `.env` under `ADMIN_EMAILS`. When a matching email logs in, the backend grants administrative privileges (OpenAI API key configuration and hosting tournaments). No role selection prompt is presented in the frontend.

---

## 📱 Mobile App (Android APK)
To synchronize web changes and build the Android APK:
```bash
npx cap sync android
npm run build:apk
```

