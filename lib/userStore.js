// Minimal file-based user store. Good enough for a small internal portal.
// For a bigger multi-tenant product, swap this for a real database
// (Postgres/MySQL/SQLite) behind the same three functions.
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const DB_PATH = path.join(__dirname, "..", "data", "users.json");

function readAll() {
  if (!fs.existsSync(DB_PATH)) return [];
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8") || "[]");
}

function writeAll(users) {
  fs.writeFileSync(DB_PATH, JSON.stringify(users, null, 2));
}

function findByUsername(username) {
  return readAll().find(u => u.username.toLowerCase() === String(username).toLowerCase());
}

function validatePassword(password) {
  const str = String(password || "");
  if (!str.trim()) throw new Error("Password cannot be empty.");
  if (str.length < 8) throw new Error("Password must be at least 8 characters.");
}

async function createUser(username, password, displayName) {
  validatePassword(password);
  const users = readAll();
  const passwordHash = await bcrypt.hash(password, 10);
  const existing = users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (existing) {
    existing.passwordHash = passwordHash;
    if (displayName) existing.displayName = displayName;
    writeAll(users);
    return { ...existing, updated: true };
  }
  const user = { id: Date.now().toString(36), username, passwordHash, displayName: displayName || username };
  users.push(user);
  writeAll(users);
  return { ...user, updated: false };
}

function listUsers() {
  return readAll().map(u => ({ id: u.id, username: u.username, displayName: u.displayName }));
}

async function verifyPassword(username, password) {
  const user = findByUsername(username);
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.passwordHash);
  return ok ? user : null;
}

module.exports = { findByUsername, createUser, verifyPassword, listUsers };
