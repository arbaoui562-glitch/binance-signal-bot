# BitGet — API Key Setup

[Sign up for BitGet](https://bonus.bitget.com/GreymatterAI) if you don't already have an account.

## What you'll get
- API Key
- Secret Key
- Passphrase (you create this yourself)

---

## Steps (Mobile App)

1. Download the BitGet app and log in
2. Tap the **Home** button at the bottom left
3. Tap your **profile picture** at the top left
4. Scroll down to the bottom and tap **More Services**
5. Along the top menu you'll see: Popular, Rewards, Earn, Trading, Assets, Tools — tap **Tools**
6. Tap **API Keys**
7. Tap **Create API Key** → **Automatically Generated API Keys**

### Fill in the details

- **Name** — give it a label, e.g. `Trader Thing`
- **Passphrase** — create one yourself. This is personal to you — write it down immediately. You cannot recover it later.
- **Bind IP Address** — optional, but recommended if you're running the bot from a fixed IP. Google "what is my IP address" and paste it in.
- **Permissions** — select what you need. At minimum:
  - **Spot Trading** — ON ✓
  - **Read** — ON ✓
  - Futures Open Interest, Spot Margin, Copy Trading, Taxation, Sub Accounts — optional, up to you
  - **Crypto Loans, P2P, Transfer, Withdrawals** — **OFF** — never turn these on

8. Tap **Confirm** and complete the verification process (email / 2FA)

### Copy your credentials

Your **API Key** and **Secret Key** appear on screen after verification.

> ⚠️ The Secret Key is only shown once. Copy it immediately and save it somewhere safe. If you lose it, you'll need to delete this key and create a new one.

---

## Paste into your .env

```
BITGET_API_KEY=your_api_key_here
BITGET_SECRET_KEY=your_secret_key_here
BITGET_PASSPHRASE=your_passphrase_here
```

Set `TRADE_MODE=spot` for spot trading or `TRADE_MODE=futures` for perpetuals.

---

## Notes

- BitGet is the bot's default configuration target — minimal setup required if you use it
- If you're using a futures account, set `TRADE_MODE=futures` in your `.env`
