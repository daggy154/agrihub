const bcrypt = require("bcrypt");

async function generateHash(){
    const password = "admin123";   // admin password you want
    const hash = await bcrypt.hash(password,10);
    console.log(hash);
}

generateHash();
