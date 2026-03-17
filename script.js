document.addEventListener("DOMContentLoaded", () => {

const API = "http://localhost:3000";

/* =====================
REGISTER
===================== */

if(window.location.pathname.includes("register.html")){

const form = document.querySelector("form");

form.addEventListener("submit", async (e)=>{
e.preventDefault();

const fullname = document.getElementById("fullname").value;
const email = document.getElementById("email").value;
const password = document.getElementById("password").value;
const role = document.getElementById("role").value;

const response = await fetch(API + "/register",{

method:"POST",
headers:{
"Content-Type":"application/json"
},

body:JSON.stringify({
fullname,
email,
password,
role
})

});

const data = await response.json();

alert(data.message);

if(data.message === "Registration successful"){
window.location.href="login.html";
}

});

}


/* =====================
LOGIN
===================== */

if(window.location.pathname.includes("login.html")){

const form = document.querySelector("form");

form.addEventListener("submit", async (e)=>{

e.preventDefault();

const email = document.getElementById("email").value;
const password = document.getElementById("password").value;

const response = await fetch(API + "/login",{

method:"POST",

headers:{
"Content-Type":"application/json"
},

body:JSON.stringify({
email,
password
})

});

const data = await response.json();

if(data.redirect){
    alert("Login successful. Click OK to continue");
    // Store user data in localStorage
    if(data.user) {
        localStorage.setItem('currentUser', JSON.stringify(data.user));
    }
    window.location.href = data.redirect;
}else{
    alert(data.message);
}

});

}

/* =====================
   USER PORTAL LOGIC
   ===================== */
if(window.location.pathname.includes("buyer_dashboard.html")){
    const userNameDisplay = document.getElementById("userNameDisplay");
    const userData = JSON.parse(localStorage.getItem('currentUser'));

    if (userData && userData.fullname) {
        // Update "Welcome, Buyer" to "Welcome, [Full Name]"
        userNameDisplay.textContent = `Welcome, ${userData.fullname}`;
    } else {
        // Optional: Redirect to login if no user data is found
        window.location.href = 'login.html';
    }
}

/* =====================
ADD PRODUCT
===================== */

if(window.location.pathname.includes("farmer_dashboard.html")){

const form = document.getElementById("productForm");
const userData = JSON.parse(localStorage.getItem('currentUser'));

if (!userData || userData.role !== 'seller') {
    alert('Please login as a farmer first');
    window.location.href = 'login.html';
}

form.addEventListener("submit", async (e)=>{

e.preventDefault();

const formData = new FormData();

formData.append("name", document.getElementById("productName").value);
formData.append("category", document.getElementById("category").value);
formData.append("price", document.getElementById("price").value);
formData.append("quantity", document.getElementById("quantity").value);
formData.append("description", document.getElementById("description").value);
formData.append("image", document.getElementById("productImage").files[0]);
formData.append("farmer_id", userData.id);
formData.append("farmer_name", userData.fullname);

const response = await fetch("http://localhost:3000/add-product",{

method:"POST",
body:formData

});

const data = await response.json();

alert(data.message);

if (data.message === "Product added successfully") {
    form.reset(); // Clear the form
}

});

}

});