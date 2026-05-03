document.addEventListener("DOMContentLoaded", () => {

const API = "http://localhost:3000";

/* =====================
REGISTER
===================== */
if (window.location.pathname.includes("register.html")) {
    const form = document.querySelector("form");

    form.addEventListener("submit", async (e) => {
        e.preventDefault();

        const fullname = document.getElementById("fullname").value;
        const email = document.getElementById("email").value;
        const password = document.getElementById("password").value;
        const role = document.getElementById("role").value;

        try {
            const response = await fetch(API + "/register", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ fullname, email, password, role })
            });

            const data = await response.json();

            if (data.redirect) {
                alert("Registration successful! Redirecting to your dashboard...");
                
                // Save user info so the dashboard can display the name
                if (data.user) {
                    localStorage.setItem('currentUser', JSON.stringify(data.user));
                }
                
                // Redirect directly to the dashboard
                window.location.href = data.redirect;
            } else {
                alert(data.message);
            }
        } catch (error) {
            console.error("Registration error:", error);
            alert("An error occurred during registration.");
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

        // --- ADD THIS LINE TO RESET IMMEDIATELY ---
        form.reset(); 

        try {
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
                if(data.user) {
                    localStorage.setItem('currentUser', JSON.stringify(data.user));
                }
                window.location.href = data.redirect;
            } else {
                alert(data.message);
            }
        } catch (error) {
            console.error("Login error:", error);
            alert("An error occurred during login.");
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

/* =====================
   ADMIN DASHBOARD LOGIC
   ===================== */
if (window.location.pathname.includes("admin_control_panel.html")) {
    const tableBody = document.getElementById("admin-table-body");

    async function loadAdminProducts() {
        try {
            // 1. Fetch products from your backend
            const response = await fetch("http://localhost:3000/api/products");
            const products = await response.json();

            // Clear existing rows
            tableBody.innerHTML = "";

            products.forEach(product => {
                // 2. Calculate the Tariff (10%)
                // We use parseFloat to ensure math works even if values are strings
                const basePrice = parseFloat(product.price);
                const finalPrice = basePrice * 1.10; 

                // 3. Create the table row
                const row = document.createElement("tr");
                row.innerHTML = `
                    <td>
                        <div class="product-cell">
                            <img src="${product.image_url}"
                                 style="width: 40px; height: 40px; border-radius: 8px; object-fit: cover;">
                            <span>${product.name}</span>
                        </div>
                    </td>
                    <td style="font-size: 0.9rem">${product.farmer_name || 'Unknown Farmer'}</td>
                    <td>${product.category}</td>
                    <td>${basePrice.toFixed(2)}</td>
                    <td class="markup-price">${finalPrice.toFixed(2)}</td>
                    <td>
                        <span class="status-badge">${product.quantity}</span>
                    </td>
                    <td>
                        <button class="action-btn btn-delete" onclick="deleteProduct(${product.id})">Remove</button>
                    </td>
                `;
                tableBody.appendChild(row);
            });
        } catch (error) {
            console.error("Error loading products for admin:", error);
            tableBody.innerHTML = "<tr><td colspan='7' style='text-align:center;'>Error loading products.</td></tr>";
        }
    }

    // Initial load
    loadAdminProducts();
}

// Global functions for the action buttons
async function deleteProduct(productId) {
    if (confirm("Are you sure you want to remove this product from the marketplace?")) {
        const response = await fetch(`http://localhost:3000/delete-product/${productId}`, {
            method: 'DELETE'
        });
        const data = await response.json();
        alert(data.message);
        location.reload(); // Refresh to show updated list
    }
}

});

// Global function for the action buttons in Admin Dashboard
async function deleteProduct(productId) {
    if (confirm("Are you sure you want to permanently remove this product? This action cannot be undone.")) {
        try {
            const response = await fetch(`http://localhost:3000/delete-product/${productId}`, {
                method: 'DELETE'
            });

            const data = await response.json();

            if (response.ok) {
                alert(data.message);
                // Refresh the product list without reloading the whole page
                location.reload(); 
            } else {
                alert("Failed to delete: " + data.message);
            }
        } catch (error) {
            console.error("Delete error:", error);
            alert("An error occurred while trying to delete the product.");
        }
    }
}