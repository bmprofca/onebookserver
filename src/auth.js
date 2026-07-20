import { loadAuth, saveAuth } from './store.js';
const SESSION_MS = 1000 * 60 * 60 * 24 * 30;
export function publicAccount(account) {
    return {
        id: account.id,
        name: account.name,
        phone: account.phone,
        email: account.email ?? null,
        role: account.role,
        shopAppId: account.shopAppId,
        phoneVerified: account.phoneVerified,
        createdAt: account.createdAt,
    };
}
export function createSession(userId) {
    const auth = loadAuth();
    const token = `${userId}.${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    auth.sessions = auth.sessions.filter((s) => s.userId !== userId && s.expiresAt > Date.now());
    auth.sessions.push({
        token,
        userId,
        createdAt: new Date().toISOString(),
        expiresAt: Date.now() + SESSION_MS,
    });
    saveAuth(auth);
    return token;
}
export function requireAuth(req, res, next) {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) {
        res.status(401).json({ error: 'Login required' });
        return;
    }
    const auth = loadAuth();
    const session = auth.sessions.find((s) => s.token === token && s.expiresAt > Date.now());
    if (!session) {
        res.status(401).json({ error: 'Session expired. Please login again.' });
        return;
    }
    const account = auth.accounts.find((a) => a.id === session.userId);
    if (!account) {
        res.status(401).json({ error: 'Account not found' });
        return;
    }
    req.account = account;
    next();
}
export function requireShopkeeper(req, res, next) {
    requireAuth(req, res, () => {
        if (req.account?.role !== 'shopkeeper') {
            res.status(403).json({ error: 'Shopkeeper access only' });
            return;
        }
        next();
    });
}
