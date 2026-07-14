// Create or update a login user:
//   node lib/seedUser.js admin 12345678 "Display Name"
// List all registered usernames (no passwords shown):
//   node lib/seedUser.js --list
const { createUser, listUsers } = require("./userStore");

const args = process.argv.slice(2);

if (args[0] === "--list") {
  const users = listUsers();
  if (!users.length) {
    console.log("No users registered yet in data/users.json.");
  } else {
    console.log("Registered users:");
    users.forEach(u => console.log(`  - ${u.username} (${u.displayName})`));
  }
  process.exit(0);
}

const [username, password, displayName] = args;

if (!username || !password) {
  console.log('Usage: node lib/seedUser.js <username> <password> "<Display Name>"');
  console.log("       node lib/seedUser.js --list");
  process.exit(1);
}

createUser(username, password, displayName)
  .then(u => {
    if (u.updated) {
      console.log(`Updated existing user "${u.username}" — password has been reset to the one you just entered.`);
    } else {
      console.log(`Created new user "${u.username}" (${u.displayName}). You can log in with this now.`);
    }
  })
  .catch(err => {
    console.error("Failed to create/update user:", err.message);
    process.exit(1);
  });
