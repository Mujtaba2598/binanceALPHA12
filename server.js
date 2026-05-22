const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 10000;
const JWT_SECRET = 'halal-binance-fixed-secret-key-2024';
const ENCRYPTION_KEY = '12345678901234567890123456789012';

// Halal Assets
const HALAL_ASSETS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'ADAUSDT', 'XRPUSDT', 'DOTUSDT', 'LINKUSDT', 'MATICUSDT', 'AVAXUSDT'];

// Trading settings
const MAX_CONCURRENT_TRADES = 50;
const PROFIT_PERCENT = 1000;              // 1000% profit target
const PROFIT_CHECK_INTERVAL = 1000;       // Check every 1 second

// Demo balances storage
let demoBalances = {};

// ========== DATA DIRECTORIES ==========
const DATA_DIR = path.join(__dirname, 'data');
const TRADES_DIR = path.join(DATA_DIR, 'trades');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const PENDING_FILE = path.join(DATA_DIR, 'pending.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(TRADES_DIR)) fs.mkdirSync(TRADES_DIR, { recursive: true });

// ========== OWNER ACCOUNT ==========
const ownerEmail = "mujtabahatif@gmail.com";
const ownerPasswordPlain = "Mujtabah@2598";
const ownerPasswordHash = bcrypt.hashSync(ownerPasswordPlain, 10);

let users = {};
if (fs.existsSync(USERS_FILE)) {
    try { users = JSON.parse(fs.readFileSync(USERS_FILE)); } catch(e) { users = {}; }
}

users[ownerEmail] = {
    email: ownerEmail,
    password: ownerPasswordHash,
    isOwner: true,
    isApproved: true,
    isBlocked: false,
    apiKey: "",
    secretKey: "",
    accountType: "real",
    createdAt: new Date().toISOString()
};
fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
console.log("✅ Owner account created");

if (!fs.existsSync(PENDING_FILE)) fs.writeFileSync(PENDING_FILE, JSON.stringify({}, null, 2));
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, JSON.stringify({}, null, 2));

// ========== HELPER FUNCTIONS ==========
function readUsers() { try { return JSON.parse(fs.readFileSync(USERS_FILE)); } catch(e) { return {}; } }
function writeUsers(data) { fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2)); }
function readPending() { try { return JSON.parse(fs.readFileSync(PENDING_FILE)); } catch(e) { return {}; } }
function writePending(data) { fs.writeFileSync(PENDING_FILE, JSON.stringify(data, null, 2)); }
function readOrders() { try { return JSON.parse(fs.readFileSync(ORDERS_FILE)); } catch(e) { return {}; } }
function writeOrders(data) { fs.writeFileSync(ORDERS_FILE, JSON.stringify(data, null, 2)); }

function encrypt(text) {
    if (!text) return "";
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text) {
    if (!text) return "";
    const parts = text.split(':');
    const iv = Buffer.from(parts.shift(), 'hex');
    const encryptedText = parts.join(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

function cleanKey(k) { return k ? k.replace(/[\s\n\r\t]+/g, '').trim() : ""; }

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: '🕋 Halal Binance Bot' });
});

// ========== AUTHENTICATION ==========
app.post('/api/register', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password required' });
    if (password.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    
    const users = readUsers();
    if (users[email]) return res.status(400).json({ success: false, message: 'User already exists' });
    const pending = readPending();
    if (pending[email]) return res.status(400).json({ success: false, message: 'Request already pending' });
    
    pending[email] = { email, password: bcrypt.hashSync(password, 10), requestedAt: new Date().toISOString() };
    writePending(pending);
    res.json({ success: true, message: 'Registration request sent to owner for approval.' });
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const users = readUsers();
    const user = users[email];
    
    if (!user) {
        const pending = readPending();
        if (pending[email]) return res.status(401).json({ success: false, message: 'Pending owner approval' });
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    
    if (!bcrypt.compareSync(password, user.password)) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    if (!user.isApproved && !user.isOwner) return res.status(401).json({ success: false, message: 'Account not approved' });
    if (user.isBlocked) return res.status(401).json({ success: false, message: 'Account blocked' });
    
    const token = jwt.sign({ email, isOwner: user.isOwner }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, isOwner: user.isOwner });
});

function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ success: false, message: 'No token' });
    const token = authHeader.split(' ')[1];
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (err) {
        res.status(401).json({ success: false, message: 'Invalid token' });
    }
}

// ========== REAL BINANCE API + DEMO MODE ==========
const BINANCE_API = 'https://api.binance.com';

async function getRealBinanceBalance(apiKey, secretKey) {
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}&recvWindow=5000`;
    const signature = crypto.createHmac('sha256', secretKey).update(queryString).digest('hex');
    const url = `${BINANCE_API}/api/v3/account?${queryString}&signature=${signature}`;
    const response = await axios({
        method: 'GET',
        url,
        headers: { 'X-MBX-APIKEY': apiKey },
        timeout: 10000
    });
    const usdtBalance = response.data.balances.find(b => b.asset === 'USDT');
    return parseFloat(usdtBalance?.free || 0);
}

async function getRealBinancePrice(symbol) {
    const response = await axios.get(`${BINANCE_API}/api/v3/ticker/price?symbol=${symbol}`);
    return parseFloat(response.data.price);
}

async function placeRealBinanceOrder(apiKey, secretKey, symbol, side, quantity, price) {
    const timestamp = Date.now();
    const params = {
        symbol, side, type: 'LIMIT', timeInForce: 'GTC',
        quantity: quantity.toFixed(6), price: price.toFixed(2),
        timestamp, recvWindow: 5000
    };
    const queryString = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
    const signature = crypto.createHmac('sha256', secretKey).update(queryString).digest('hex');
    const url = `${BINANCE_API}/api/v3/order?${queryString}&signature=${signature}`;
    const response = await axios({
        method: 'POST',
        url,
        headers: { 'X-MBX-APIKEY': apiKey },
        timeout: 10000
    });
    return response.data;
}

async function checkRealBinanceOrderStatus(apiKey, secretKey, symbol, orderId) {
    const timestamp = Date.now();
    const queryString = `symbol=${symbol}&orderId=${orderId}&timestamp=${timestamp}&recvWindow=5000`;
    const signature = crypto.createHmac('sha256', secretKey).update(queryString).digest('hex');
    const url = `${BINANCE_API}/api/v3/order?${queryString}&signature=${signature}`;
    const response = await axios({
        method: 'GET',
        url,
        headers: { 'X-MBX-APIKEY': apiKey },
        timeout: 10000
    });
    return response.data;
}

// Demo mode functions
function getDemoBalance(email) {
    if (!demoBalances[email]) {
        demoBalances[email] = 10000;
    }
    return demoBalances[email];
}

function updateDemoBalance(email, newBalance) {
    demoBalances[email] = newBalance;
}

function getDemoPrice(symbol) {
    const prices = {
        'BTCUSDT': 50000, 'ETHUSDT': 3000, 'BNBUSDT': 400, 'SOLUSDT': 100,
        'ADAUSDT': 0.5, 'XRPUSDT': 0.6, 'DOTUSDT': 7, 'LINKUSDT': 15,
        'MATICUSDT': 0.8, 'AVAXUSDT': 35
    };
    return prices[symbol] || 100;
}

// ========== API KEY MANAGEMENT ==========
app.post('/api/set-binance-keys', authenticate, async (req, res) => {
    let { apiKey, secretKey, accountType } = req.body;
    const users = readUsers();
    
    if (accountType === 'demo') {
        users[req.user.email].apiKey = "demo_mode";
        users[req.user.email].secretKey = "demo_mode";
        users[req.user.email].accountType = "demo";
        writeUsers(users);
        const demoBalance = getDemoBalance(req.user.email);
        res.json({ success: true, message: `✅ Demo mode activated! Practice balance: $${demoBalance.toFixed(2)} USDT`, balance: demoBalance });
        return;
    }
    
    if (!apiKey || !secretKey) {
        return res.status(400).json({ success: false, message: 'Both API keys required for real trading' });
    }
    
    const cleanApi = cleanKey(apiKey);
    const cleanSecret = cleanKey(secretKey);
    
    try {
        const balance = await getRealBinanceBalance(cleanApi, cleanSecret);
        users[req.user.email].apiKey = encrypt(cleanApi);
        users[req.user.email].secretKey = encrypt(cleanSecret);
        users[req.user.email].accountType = "real";
        writeUsers(users);
        
        res.json({ success: true, message: `✅ API keys saved! Balance: ${balance} USDT`, balance: balance });
    } catch (err) {
        res.status(401).json({ success: false, message: 'Invalid API keys. Make sure "Enable Spot & Margin Trading" is enabled.' });
    }
});

app.post('/api/connect-binance', authenticate, async (req, res) => {
    const { accountType } = req.body;
    const user = readUsers()[req.user.email];
    
    let effectiveMode = accountType;
    if (!effectiveMode || (effectiveMode !== 'demo' && effectiveMode !== 'real')) {
        effectiveMode = user?.accountType || 'real';
    }
    
    if (effectiveMode === 'demo') {
        const demoBalance = getDemoBalance(req.user.email);
        return res.json({
            success: true,
            balance: demoBalance,
            message: `✅ Connected to DEMO MODE! Practice balance: $${demoBalance.toFixed(2)} USDT`
        });
    }
    
    if (!user?.apiKey || user.apiKey === "demo_mode") {
        return res.status(400).json({
            success: false,
            message: 'No API keys saved. Please add your Binance API keys or switch to Demo Mode.'
        });
    }
    
    const apiKey = decrypt(user.apiKey);
    const secretKey = decrypt(user.secretKey);
    
    try {
        const balance = await getRealBinanceBalance(apiKey, secretKey);
        res.json({
            success: true,
            balance,
            message: `✅ Connected to REAL BINANCE! Balance: ${balance} USDT`
        });
    } catch (error) {
        res.status(401).json({ success: false, message: error.message });
    }
});

app.get('/api/get-keys', authenticate, (req, res) => {
    const user = readUsers()[req.user.email];
    if (!user?.apiKey) return res.json({ success: false, message: 'No keys saved' });
    res.json({
        success: true,
        apiKey: user.apiKey === "demo_mode" ? "" : decrypt(user.apiKey),
        secretKey: user.secretKey === "demo_mode" ? "" : decrypt(user.secretKey),
        accountType: user.accountType || 'real'
    });
});

app.post('/api/get-balance', authenticate, async (req, res) => {
    const { accountType } = req.body;
    const user = readUsers()[req.user.email];
    
    if (accountType === 'demo') {
        const balance = getDemoBalance(req.user.email);
        res.json({ success: true, balance });
        return;
    }
    
    if (!user?.apiKey || user.apiKey === "demo_mode") {
        return res.json({ success: false, message: 'No API keys. Please add your Binance API keys.' });
    }
    
    const apiKey = decrypt(user.apiKey);
    const secretKey = decrypt(user.secretKey);
    
    try {
        const balance = await getRealBinanceBalance(apiKey, secretKey);
        res.json({ success: true, balance });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// ========== FIXED TRADING ENGINE (Minimum $10 per trade) ==========
const activeSessions = new Map();
let assetIndex = 0;

function nextAsset() {
    const asset = HALAL_ASSETS[assetIndex];
    assetIndex = (assetIndex + 1) % HALAL_ASSETS.length;
    return asset;
}

app.post('/api/start-trading', authenticate, async (req, res) => {
    try {
        const { investmentAmount, targetAmount, timeLimitHours, accountType } = req.body;
        
        if (!investmentAmount || !targetAmount) return res.status(400).json({ success: false, message: 'Investment and target required' });
        if (investmentAmount < 10) return res.status(400).json({ success: false, message: 'Minimum investment $10' });
        if (targetAmount <= investmentAmount) return res.status(400).json({ success: false, message: 'Target must be greater than investment' });
        
        const user = readUsers()[req.user.email];
        const isDemo = accountType === 'demo';
        let balance = 0;
        
        if (isDemo) {
            balance = getDemoBalance(req.user.email);
        } else {
            if (!user?.apiKey || user.apiKey === "demo_mode") {
                return res.status(400).json({ success: false, message: 'Add Binance API keys first' });
            }
            const apiKey = decrypt(user.apiKey);
            const secretKey = decrypt(user.secretKey);
            try {
                balance = await getRealBinanceBalance(apiKey, secretKey);
            } catch (error) {
                return res.status(401).json({ success: false, message: 'Cannot verify balance: ' + error.message });
            }
        }
        
        if (balance < investmentAmount) {
            return res.status(400).json({ success: false, message: `Insufficient balance. You have ${balance} USDT, need ${investmentAmount}` });
        }
        
        const sessionId = crypto.randomBytes(8).toString('hex');
        const mode = isDemo ? 'DEMO (Practice)' : 'REAL BINANCE';
        
        const sessionData = {
            userId: req.user.email,
            initialInvestment: investmentAmount,
            targetAmount: targetAmount,
            currentBalance: investmentAmount,
            totalProfit: 0,
            startTime: Date.now(),
            timeLimit: timeLimitHours || 1,
            activeTrades: [],
            completedTrades: [],
            isDemo: isDemo,
            status: 'ACTIVE'
        };
        
        activeSessions.set(sessionId, sessionData);
        startAggressiveTrading(sessionId);
        
        const profitNeeded = targetAmount - investmentAmount;
        const requiredReturn = ((targetAmount / investmentAmount) - 1) * 100;
        
        res.json({
            success: true,
            sessionId,
            message: `✅ HALAL TRADING STARTED!\n📊 Mode: ${mode}\n💰 Investment: $${investmentAmount}\n🎯 Target: $${targetAmount}\n📈 Profit Needed: $${profitNeeded} (${requiredReturn.toFixed(1)}% return)\n⏰ Time Limit: ${timeLimitHours || 1} hours\n\n🕋 ISLAMIC REMINDER: NO Riba, NO Gharar, NO Maysir, NO leverage, NO short selling.\n\n⚡ Bot will place up to ${MAX_CONCURRENT_TRADES} concurrent trades with ${PROFIT_PERCENT}% profit target per trade. Each trade will use at least $10.`
        });
        
    } catch (error) {
        console.error('Start trading error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

async function startAggressiveTrading(sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session || session.status !== 'ACTIVE') return;
    
    // Check if target reached
    if (session.currentBalance >= session.targetAmount) {
        session.status = 'TARGET_REACHED';
        console.log(`🎯 TARGET REACHED! ${session.userId} achieved $${session.currentBalance.toFixed(2)} from $${session.initialInvestment}`);
        activeSessions.delete(sessionId);
        return;
    }
    
    // Check time limit
    const elapsedHours = (Date.now() - session.startTime) / (1000 * 60 * 60);
    if (elapsedHours >= session.timeLimit) {
        session.status = 'TIME_LIMIT_REACHED';
        console.log(`⏰ TIME LIMIT REACHED for ${session.userId}. Final balance: $${session.currentBalance.toFixed(2)}`);
        activeSessions.delete(sessionId);
        return;
    }
    
    // Process existing trades
    for (let i = 0; i < session.activeTrades.length; i++) {
        const trade = session.activeTrades[i];
        
        if (trade.status === 'BUY_ORDER_PLACED') {
            if (session.isDemo && Date.now() - trade.createdAt > 1000) {
                trade.status = 'BUY_FILLED';
                trade.fillPrice = trade.buyPrice;
                trade.filledQuantity = trade.quantity;
                console.log(`✅ BUY ORDER FILLED (DEMO): ${trade.filledQuantity} ${trade.symbol} @ ${trade.fillPrice}`);
                
                const sellPrice = trade.fillPrice * (1 + PROFIT_PERCENT / 100);
                trade.sellPrice = sellPrice;
                trade.sellOrderId = Date.now() + 1;
                trade.status = 'SELL_ORDER_PLACED';
                trade.sellCreatedAt = Date.now();
                console.log(`📈 SELL ORDER PLACED: ${trade.filledQuantity} ${trade.symbol} @ ${sellPrice} (${PROFIT_PERCENT}% profit target)`);
            }
        } else if (trade.status === 'SELL_ORDER_PLACED') {
            if (session.isDemo && Date.now() - trade.sellCreatedAt > 1000) {
                const profit = (trade.sellPrice - trade.fillPrice) * trade.filledQuantity;
                session.currentBalance += profit;
                session.totalProfit += profit;
                trade.status = 'COMPLETED';
                trade.profit = profit;
                trade.exitPrice = trade.sellPrice;
                session.completedTrades.push(trade);
                
                console.log(`✅ SELL ORDER FILLED! Profit: $${profit.toFixed(2)}. New balance: $${session.currentBalance.toFixed(2)}`);
                
                const historyFile = path.join(TRADES_DIR, session.userId.replace(/[^a-z0-9]/gi, '_') + '.json');
                let history = [];
                if (fs.existsSync(historyFile)) history = JSON.parse(fs.readFileSync(historyFile));
                history.unshift({
                    symbol: trade.symbol,
                    entryPrice: trade.fillPrice,
                    exitPrice: trade.exitPrice,
                    quantity: trade.filledQuantity,
                    profit: profit,
                    profitPercent: (profit / (trade.fillPrice * trade.filledQuantity)) * 100,
                    timestamp: new Date().toISOString(),
                    isHalal: true,
                    mode: session.isDemo ? 'demo' : 'real'
                });
                fs.writeFileSync(historyFile, JSON.stringify(history.slice(0, 500), null, 2));
                
                session.activeTrades.splice(i, 1);
                i--;
            }
        }
    }
    
    // If target reached after trade completion
    if (session.currentBalance >= session.targetAmount) {
        session.status = 'TARGET_REACHED';
        console.log(`🎯 TARGET REACHED! Balance: $${session.currentBalance.toFixed(2)}`);
        activeSessions.delete(sessionId);
        return;
    }
    
    // Calculate remaining amount needed
    const remainingNeeded = session.targetAmount - session.currentBalance;
    const timeRemaining = Math.max(0.1, (session.startTime + session.timeLimit * 3600000 - Date.now()) / 3600000);
    
    // --- FIX: Ensure each trade uses at least $10 ---
    let tradesToPlace = Math.min(MAX_CONCURRENT_TRADES - session.activeTrades.length, Math.max(1, Math.ceil(10 / timeRemaining)));
    tradesToPlace = Math.max(1, Math.min(MAX_CONCURRENT_TRADES, tradesToPlace));
    
    // Base investment per trade – at least $10, at most 20% of current balance
    let investmentPerTrade = Math.max(10, Math.min(session.currentBalance * 0.2, remainingNeeded / tradesToPlace));
    // If current balance is less than $10, use the whole balance
    if (session.currentBalance < 10) {
        investmentPerTrade = session.currentBalance;
        tradesToPlace = 1;
    }
    // Never invest more than the current balance
    investmentPerTrade = Math.min(investmentPerTrade, session.currentBalance);
    
    // Place new trades
    let newTradesPlaced = 0;
    for (let i = 0; i < tradesToPlace; i++) {
        if (session.currentBalance >= session.targetAmount) break;
        if (session.activeTrades.length >= MAX_CONCURRENT_TRADES) break;
        
        const symbol = nextAsset();
        let currentPrice;
        if (session.isDemo) {
            currentPrice = getDemoPrice(symbol);
        } else {
            try {
                currentPrice = await getRealBinancePrice(symbol);
            } catch (error) {
                console.error(`Price fetch error for ${symbol}:`, error.message);
                continue;
            }
        }
        
        const buyPrice = currentPrice * 0.998;
        const quantity = investmentPerTrade / buyPrice;
        
        let roundedQty = Math.floor(quantity * 10000) / 10000;
        if (symbol === 'BTCUSDT') roundedQty = Math.floor(quantity * 100000) / 100000;
        if (roundedQty < 0.00001) continue;
        
        try {
            let order;
            if (session.isDemo) {
                order = { orderId: Date.now() + i, status: 'NEW' };
            } else {
                const user = readUsers()[session.userId];
                const apiKey = decrypt(user.apiKey);
                const secretKey = decrypt(user.secretKey);
                order = await placeRealBinanceOrder(apiKey, secretKey, symbol, 'BUY', roundedQty, buyPrice);
            }
            
            session.activeTrades.push({
                symbol: symbol,
                quantity: roundedQty,
                buyPrice: buyPrice,
                buyOrderId: order.orderId,
                status: 'BUY_ORDER_PLACED',
                createdAt: Date.now()
            });
            newTradesPlaced++;
            console.log(`📈 NEW BUY ORDER #${newTradesPlaced}: $${investmentPerTrade.toFixed(2)} → ${roundedQty} ${symbol} @ ${buyPrice} (${PROFIT_PERCENT}% profit target) | Active trades: ${session.activeTrades.length}/${MAX_CONCURRENT_TRADES}`);
            
        } catch (error) {
            console.error(`Failed to place order for ${symbol}:`, error.message);
        }
    }
    
    if (newTradesPlaced > 0) {
        console.log(`✅ Placed ${newTradesPlaced} new orders. Total active: ${session.activeTrades.length}/${MAX_CONCURRENT_TRADES}`);
        console.log(`📊 Progress: $${session.currentBalance.toFixed(2)} / $${session.targetAmount.toFixed(2)} (${((session.currentBalance - session.initialInvestment) / (session.targetAmount - session.initialInvestment) * 100).toFixed(1)}%)`);
    }
    
    setTimeout(() => { startAggressiveTrading(sessionId); }, PROFIT_CHECK_INTERVAL);
}

app.post('/api/stop-trading', authenticate, (req, res) => {
    const { sessionId } = req.body;
    if (activeSessions.has(sessionId)) {
        activeSessions.get(sessionId).status = 'STOPPED_BY_USER';
        activeSessions.delete(sessionId);
        res.json({ success: true, message: 'Trading stopped successfully' });
    } else {
        res.json({ success: false, message: 'Session not found' });
    }
});

app.post('/api/trade-status', authenticate, (req, res) => {
    const session = activeSessions.get(req.body.sessionId);
    if (!session) return res.json({ success: true, active: false });
    
    const elapsedHours = (Date.now() - session.startTime) / (1000 * 60 * 60);
    const timeRemaining = Math.max(0, session.timeLimit - elapsedHours);
    const progressPercent = ((session.currentBalance - session.initialInvestment) / (session.targetAmount - session.initialInvestment)) * 100;
    const winRate = session.completedTrades.length > 0 ? 
        (session.completedTrades.filter(t => t.profit > 0).length / session.completedTrades.length) * 100 : 0;
    
    res.json({
        success: true,
        active: session.status === 'ACTIVE',
        initialInvestment: session.initialInvestment,
        targetAmount: session.targetAmount,
        currentBalance: session.currentBalance,
        totalProfit: session.totalProfit,
        progressPercent: Math.min(100, Math.max(0, progressPercent)).toFixed(1),
        totalTrades: session.completedTrades.length + session.activeTrades.length,
        completedTrades: session.completedTrades.length,
        activeTradesCount: session.activeTrades.length,
        winRate: winRate.toFixed(1),
        timeRemaining: timeRemaining.toFixed(2),
        status: session.status
    });
});

app.get('/api/trade-history', authenticate, (req, res) => {
    const file = path.join(TRADES_DIR, req.user.email.replace(/[^a-z0-9]/gi, '_') + '.json');
    if (!fs.existsSync(file)) return res.json({ success: true, trades: [] });
    const trades = JSON.parse(fs.readFileSync(file));
    res.json({ success: true, trades: trades });
});

app.get('/api/halal-assets', authenticate, (req, res) => {
    res.json({ success: true, assets: HALAL_ASSETS });
});

// ========== ADMIN ENDPOINTS ==========
app.get('/api/admin/pending-users', authenticate, (req, res) => {
    if (!req.user.isOwner) return res.status(403).json({ success: false });
    const pending = readPending();
    res.json({ success: true, pending: Object.keys(pending).map(e => ({ email: e, requestedAt: pending[e].requestedAt })) });
});

app.post('/api/admin/approve-user', authenticate, (req, res) => {
    if (!req.user.isOwner) return res.status(403).json({ success: false });
    const { email } = req.body;
    const pending = readPending();
    if (!pending[email]) return res.status(404).json({ success: false });
    const users = readUsers();
    users[email] = {
        email, password: pending[email].password, isOwner: false, isApproved: true,
        isBlocked: false, apiKey: "", secretKey: "", createdAt: new Date().toISOString()
    };
    writeUsers(users);
    delete pending[email];
    writePending(pending);
    res.json({ success: true, message: `User ${email} approved` });
});

app.post('/api/admin/reject-user', authenticate, (req, res) => {
    if (!req.user.isOwner) return res.status(403).json({ success: false });
    const { email } = req.body;
    const pending = readPending();
    if (!pending[email]) return res.status(404).json({ success: false });
    delete pending[email];
    writePending(pending);
    res.json({ success: true, message: `User ${email} rejected` });
});

app.post('/api/admin/toggle-block', authenticate, (req, res) => {
    if (!req.user.isOwner) return res.status(403).json({ success: false });
    const { email } = req.body;
    const users = readUsers();
    if (!users[email]) return res.status(404).json({ success: false });
    users[email].isBlocked = !users[email].isBlocked;
    writeUsers(users);
    res.json({ success: true, message: `User ${email} is now ${users[email].isBlocked ? 'BLOCKED' : 'ACTIVE'}` });
});

app.get('/api/admin/users', authenticate, (req, res) => {
    if (!req.user.isOwner) return res.status(403).json({ success: false });
    const users = readUsers();
    res.json({ success: true, users: Object.keys(users).map(e => ({
        email: e,
        hasApiKeys: !!users[e].apiKey && users[e].apiKey !== "demo_mode",
        isOwner: users[e].isOwner,
        isApproved: users[e].isApproved,
        isBlocked: users[e].isBlocked,
        accountType: users[e].accountType || 'real'
    })) });
});

app.get('/api/admin/user-balances', authenticate, async (req, res) => {
    if (!req.user.isOwner) return res.status(403).json({ success: false });
    const users = readUsers();
    const balances = {};
    for (const [email, u] of Object.entries(users)) {
        if (u.accountType === 'demo') {
            balances[email] = { balance: getDemoBalance(email), hasKeys: true, mode: 'demo' };
        } else if (u.apiKey && u.apiKey !== "demo_mode") {
            try {
                const apiKey = decrypt(u.apiKey);
                const secretKey = decrypt(u.secretKey);
                const balance = await getRealBinanceBalance(apiKey, secretKey);
                balances[email] = { balance, hasKeys: true, mode: 'real' };
            } catch {
                balances[email] = { balance: 0, hasKeys: true, error: true };
            }
        } else {
            balances[email] = { balance: 0, hasKeys: false };
        }
    }
    res.json({ success: true, balances });
});

app.get('/api/admin/all-trades', authenticate, (req, res) => {
    if (!req.user.isOwner) return res.status(403).json({ success: false });
    const allTrades = {};
    const files = fs.readdirSync(TRADES_DIR);
    for (const file of files) {
        if (file === '.gitkeep') continue;
        const userId = file.replace('.json', '');
        allTrades[userId] = JSON.parse(fs.readFileSync(path.join(TRADES_DIR, file)));
    }
    res.json({ success: true, trades: allTrades });
});

app.post('/api/change-password', authenticate, (req, res) => {
    if (!req.user.isOwner) return res.status(403).json({ success: false });
    const { currentPassword, newPassword } = req.body;
    const users = readUsers();
    const owner = users[req.user.email];
    if (!bcrypt.compareSync(currentPassword, owner.password)) return res.status(401).json({ success: false, message: 'Wrong current password' });
    owner.password = bcrypt.hashSync(newPassword, 10);
    writeUsers(users);
    res.json({ success: true, message: 'Password changed! Please login again.' });
});

// Serve frontend
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n========================================`);
    console.log(`🕋 HALAL BINANCE BOT - RUNNING (FIXED)`);
    console.log(`========================================`);
    console.log(`✅ Owner: ${ownerEmail}`);
    console.log(`✅ Password: ${ownerPasswordPlain}`);
    console.log(`✅ ${HALAL_ASSETS.length} Halal Assets`);
    console.log(`✅ MAX CONCURRENT TRADES: ${MAX_CONCURRENT_TRADES}`);
    console.log(`✅ PROFIT TARGET: ${PROFIT_PERCENT}% per trade (10x return)`);
    console.log(`✅ FIXED: Minimum $10 per trade`);
    console.log(`✅ DEMO MODE: Practice with fake money`);
    console.log(`✅ REAL MODE: Trade with real Binance account`);
    console.log(`✅ 100% HALAL - No Riba, No Gharar, No Maysir, No Leverage`);
    console.log(`========================================`);
    console.log(`Server running on port: ${PORT}`);
});
