## 🚀 Setup Guide

Follow these steps to get the bot running on your Discord server.

---

### 1️⃣ Create a Discord Bot

1. Go to the **Discord Developer Portal**
2. Click **New Application**
3. Give it a name (e.g., `osu! Tournament Bot`)
4. Open the **Bot** tab
5. Click **Add Bot** → **Confirm**

---

### 2️⃣ Get Your Bot Token

1. In the **Bot** tab, click **Reset Token**
2. Copy the token  
   ⚠️ **Keep this secret — never share it or commit it to GitHub**

Enable these **Privileged Gateway Intents**:
- ✅ Message Content Intent
- ✅ Server Members Intent

---

### 3️⃣ Invite the Bot to Your Server

1. Go to **OAuth2 → URL Generator**
2. Select **Scopes**:
   - ✅ `bot`
   - ✅ `applications.commands`

3. Select **Bot Permissions**:
   - ✅ Manage Roles
   - ✅ Manage Channels
   - ✅ Send Messages
   - ✅ Embed Links
   - ✅ Attach Files
   - ✅ Mention Everyone
   - ✅ Read Message History
   - ✅ Use Slash Commands

4. Copy the generated URL
5. Open it in your browser
6. Select your server and click **Authorize**

---

### 4️⃣ Download & Install the Bot

1. Download this repository  
   (**Code → Download ZIP** or clone it)
2. Extract the files
3. Open a terminal in the project folder
4. Install dependencies and then install the bot:

```
   npm install
   node bot.js
```

## 🎯 Typical Workflow

1. **Initial Setup:**
```
   /setup announcement_channel:#tournaments
```

2. **Start Monitoring:**
```
   /autoscan start
```

3. **Review Drafts:**
   - Check `#tournament-review` channel
   - Click ✏️ Edit if needed
   - Click ✅ Approve to post
   - Click ❌ Deny to discard

4. **During Quiet Periods:**
```
   /autoscan stop
```

5. **Quick Checks:**
```
   /scan
```

---

## 📝 Commands

All commands require **Administrator** permissions unless specified.

### Setup Commands

| Command | Description | Example |
|---------|-------------|---------|
| `/setup` | Initial server setup - creates roles and channels | `/setup announcement_channel:#tournaments` |

### Scanning Commands

| Command | Description | When to Use |
|---------|-------------|-------------|
| `/scan` | **Quick Scan** - Checks for tournaments for up to 1 minute, then stops | When you want a one-time check |
| `/autoscan start` | **Start Continuous Scanning** - Checks every 5 minutes until stopped | When you want ongoing monitoring |
| `/autoscan stop` | **Stop Continuous Scanning** - Stops the auto-scan | When you want to pause monitoring |
| `/autoscan status` | **Check Status** - See if auto-scan is running | To check current scanning status |

### Info Commands

| Command | Who Can Use | Description |
|---------|-------------|-------------|
| `/about` | Everyone | Learn about the bot, see commands and credits |

### Legacy Commands

| Command | Description |
|---------|-------------|
| `!check` | Manual one-time check (use `/scan` instead) |

---

## 🔍 Scanning Modes Explained

### Quick Scan (`/scan`)
Perfect for occasional checks:
- ✅ Runs for up to **1 minute**
- ✅ Stops automatically when new tournaments are found
- ✅ Stops after 1 minute if nothing found
- ✅ Great for testing or infrequent checking

**Example:**
```
You: /scan
Bot: 🔍 Starting quick scan...
     ✅ Found 3 new tournament(s)! Check #tournament-review.
```

### Continuous Scan (`/autoscan start`)
Perfect for active tournament seasons:
- ✅ Checks every **5 minutes** automatically
- ✅ Runs until you manually stop it
- ✅ Survives bot restarts (you'll need to start again)
- ✅ Best for high-activity periods

**Example:**
```
You: /autoscan start
Bot: ✅ Auto-scan started!
     🔄 The bot will now check for tournaments every 5 minutes.
     ⏹️ Use /autoscan stop to stop scanning.

You: /autoscan status
Bot: ✅ Status: Running
     ⏱️ Interval: Every 5 minutes

You: /autoscan stop
Bot: ⏹️ Auto-scan stopped.
```

### Which Should I Use?

| Situation | Recommended Command |
|-----------|---------------------|
| Just finished setup | `/scan` (quick test) |
| Tournament season starting | `/autoscan start` |
| Checking after hearing about a new tournament | `/scan` |
| Want 24/7 monitoring | `/autoscan start` |
| Tournament season ended | `/autoscan stop` |
| Not sure what's happening | `/autoscan status` |

---