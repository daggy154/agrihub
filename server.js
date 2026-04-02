const express = require("express");
const bcrypt = require("bcrypt");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const http = require("http");
const socketIo = require("socket.io");
const db = require("./config/db");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*"
  }
});

io.on('connection', (socket) => {
  console.log('🟢 Client connected:', socket.id);

  socket.on('disconnect', () => {
    console.log('🔴 Client disconnected:', socket.id);
  });
});

app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(cors());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use(express.static("public"));
app.use("/uploads", express.static("uploads"));

// WebSocket connection handling
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);
  connectedClients.add(socket);
  
  socket.on('disconnect', () => {
    connectedClients.delete(socket);
    console.log('Client disconnected:', socket.id);
  });
});

function broadcastSettingsUpdate(settings) {
  io.emit('settingsUpdated', settings); // 🔥 sends to ALL clients
  console.log("📡 Settings broadcasted:", settings);
}

// Image storage config
const storage = multer.diskStorage({
    destination: function(req, file, cb){
        cb(null, "uploads/");
    },
    filename: function(req, file, cb){
        cb(null, Date.now() + path.extname(file.originalname));
    }
});

const upload = multer({storage: storage});

/* =========================
   REGISTER USER
========================= */
app.post("/register", async (req, res) => {
    const { fullname, email, password, role } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);

    const sql = "INSERT INTO users(fullname, email, password, role) VALUES(?,?,?,?)";

    db.query(sql, [fullname, email, hashedPassword, role], (err, result) => {
        if (err) {
            return res.json({ message: "Email already exists" });
        }

        // Get the ID of the user just created
        const userId = result.insertId;

        const userData = {
            id: userId,
            fullname: fullname,
            email: email,
            role: role
        };

        // Determine redirect path based on role
        let redirectPath = "buyer_dashboard.html";
        if (role === "seller") {
            redirectPath = "farmer_dashboard.html";
        } else if (role === "admin") {
            redirectPath = "admin_control_panel.html";
        }

        res.json({
            message: "Registration successful",
            redirect: redirectPath,
            user: userData
        });
    });
});

/* =========================
   LOGIN USER
========================= */
app.post("/login",(req,res)=>{

    const {email,password} = req.body;

    const sql = "SELECT * FROM users WHERE email=?";

    db.query(sql,[email], async (err,result)=>{

        if(result.length === 0){
            return res.json({message:"User not found"});
        }

        const user = result[0];

        const match = await bcrypt.compare(password,user.password);

        if(!match){
            return res.json({message:"Incorrect password"});
        }

        /* Redirect based on role with user info */
        const userData = {
            id: user.id,
            fullname: user.fullname,
            email: user.email,
            role: user.role
        };

        if(user.role === "seller"){
            res.json({
                redirect:"farmer_dashboard.html",
                user: userData
            });
        }
        else if(user.role === "buyer"){
            res.json({
                redirect:"buyer_dashboard.html",
                user: userData
            });
        }
        else{
            res.json({
                redirect:"admin_control_panel.html",
                user: userData
            });
        }

    });

});

// Add product (farmer)
app.post("/add-product", upload.single("image"), (req, res) => {
    const {name, category, price, quantity, description, farmer_id, farmer_name} = req.body;
    const image = req.file ? req.file.filename : null;
    
    const sql = `
    INSERT INTO products
    (name, category, price, quantity, description, image, farmer_id, farmer_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    db.query(sql, [name, category, price, quantity, description, image, farmer_id, farmer_name], (err, result) => {
        if(err){
            console.log(err);
            return res.json({message: "Error adding product"});
        }
        res.json({message:"Product added successfully"});
    });
});

/* =========================
   GET ALL PRODUCTS
========================= */
app.get("/products",(req,res)=>{

    const sql = "SELECT * FROM products ORDER BY id DESC";

    db.query(sql,(err,result)=>{

        if(err){
            console.log(err);
            return res.json([]);
        }

        res.json(result);

    });

});

/* =========================
   BUY PRODUCT (10% tariff) - UPDATED WITH QUANTITY MANAGEMENT
========================= */
app.post("/buy-product", (req, res) => {
    const { product_id, buyer_id, total_price, quantity, base_price, service_fee_percent } = req.body;
    
    // Validate inputs
    if (!product_id || !buyer_id || !quantity || quantity <= 0) {
        return res.status(400).json({ message: 'Invalid purchase data' });
    }
    
    // Start a transaction to ensure data consistency
    db.beginTransaction((err) => {
        if (err) {
            console.error('Transaction error:', err);
            return res.status(500).json({ message: "Transaction error" });
        }
        
        // 1. Get the current product (with row lock to prevent race conditions)
        const getProductSql = "SELECT * FROM products WHERE id = ?";
        
        db.query(getProductSql, [product_id], (err, productResult) => {
            if (err) {
                return db.rollback(() => {
                    console.error('Error fetching product:', err);
                    res.status(500).json({ message: "Error fetching product" });
                });
            }
            
            if (productResult.length === 0) {
                return db.rollback(() => {
                    res.status(404).json({ message: 'Product not found' });
                });
            }
            
            const currentProduct = productResult[0];
            
            // 2. Check if enough quantity is available
            if (currentProduct.quantity < quantity) {
                return db.rollback(() => {
                    res.status(400).json({ 
                        message: `Insufficient quantity. Only ${currentProduct.quantity} available`,
                        available: currentProduct.quantity
                    });
                });
            }
            
            // 3. Calculate service fee using current settings or provided percent
            const basePriceValue = base_price || currentProduct.price;
            // Get current service fee from settings if not provided
            let serviceFeePercent = service_fee_percent || 10;
            
            // Try to get latest settings from database
            const getSettingsSql = "SELECT serviceFeePercent FROM site_settings WHERE id = 1";
            db.query(getSettingsSql, (err, settingsResult) => {
                if (!err && settingsResult && settingsResult.length > 0) {
                    serviceFeePercent = settingsResult[0].serviceFeePercent || 10;
                }
                
                const serviceFee = basePriceValue * quantity * (serviceFeePercent / 100);
                const totalPriceValue = total_price || (basePriceValue * quantity + serviceFee);
                
                // 4. Create order record with timestamp
                const insertOrderSql = `
                    INSERT INTO orders 
                    (product_id, buyer_id, price, tariff, total_price, quantity, status, order_date) 
                    VALUES (?, ?, ?, ?, ?, ?, 'pending', NOW())
                `;
                
                db.query(insertOrderSql, [
                    product_id, 
                    buyer_id, 
                    basePriceValue, 
                    serviceFee, 
                    totalPriceValue, 
                    quantity
                ], (err, orderResult) => {
                    if (err) {
                        return db.rollback(() => {
                            console.error('Error creating order:', err);
                            res.status(500).json({ message: "Error creating order" });
                        });
                    }
                    
                    // 5. UPDATE PRODUCT QUANTITY - SUBTRACT THE ORDERED QUANTITY
                    const newQuantity = currentProduct.quantity - quantity;
                    const updateProductSql = "UPDATE products SET quantity = ? WHERE id = ?";
                    
                    db.query(updateProductSql, [newQuantity, product_id], (err, updateResult) => {
                        if (err) {
                            return db.rollback(() => {
                                console.error('Error updating product quantity:', err);
                                res.status(500).json({ message: "Error updating product quantity" });
                            });
                        }
                        
                        // 6. Commit the transaction
                        db.commit((err) => {
                            if (err) {
                                return db.rollback(() => {
                                    console.error('Error committing transaction:', err);
                                    res.status(500).json({ message: "Transaction commit error" });
                                });
                            }
                            
                            // 7. Return success response with updated data
                            res.status(200).json({
                                success: true,
                                message: "Purchase successful",
                                transaction_id: orderResult.insertId,
                                product_id: product_id,
                                new_quantity: newQuantity,
                                quantity_ordered: quantity,
                                base_price: basePriceValue,
                                service_fee: serviceFee,
                                service_fee_percent: serviceFeePercent,
                                total_price: totalPriceValue
                            });
                        });
                    });
                });
            });
        });
    });
});

/* =========================
   GET PRODUCTS WITH IMAGE URLS AND FARMER INFO
========================= */
app.get("/api/products", (req, res) => {
    const sql = "SELECT * FROM products ORDER BY id DESC";
    
    db.query(sql, (err, results) => {
        if (err) {
            console.log(err);
            return res.status(500).json({ error: "Database error" });
        }
        
        // Add full URL for each image
        const productsWithUrls = results.map(product => ({
            ...product,
            image_url: product.image ? `http://localhost:3000/uploads/${product.image}` : null
        }));
        
        res.json(productsWithUrls);
    });
});

/* =========================
   DELETE PRODUCT (ADMIN)
========================= */
app.delete("/delete-product/:id", (req, res) => {
    const productId = req.params.id;
    const sql = "DELETE FROM products WHERE id = ?";

    db.query(sql, [productId], (err, result) => {
        if (err) {
            console.error("Database error during deletion:", err);
            return res.status(500).json({ message: "Error deleting product from database" });
        }
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "Product not found" });
        }

        res.json({ message: "Product successfully removed from marketplace" });
    });
});

/* =========================
   UPDATE PRODUCT
========================= */
app.put("/api/products/:id", (req, res) => {
    const { price, category, quantity } = req.body;

    const sql = `
        UPDATE products 
        SET price = ?, category = ?, quantity = ?
        WHERE id = ?
    `;

    db.query(sql, [price, category, quantity, req.params.id], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Update failed" });
        }

        res.json({ message: "Product updated successfully" });
    });
});

/* =========================
   GET ALL USERS (ADMIN)
========================= */
app.get("/api/users", (req, res) => {
    db.query("SELECT id, fullname, email, role FROM users", (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error fetching users" });
        }
        res.json(result);
    });
});

/* =========================
   DELETE USER (ADMIN)
========================= */
app.delete("/api/users/:id", (req, res) => {
    db.query("DELETE FROM users WHERE id = ?", [req.params.id], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error deleting user" });
        }

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "User not found" });
        }

        res.json({ message: "User deleted successfully" });
    });
});

/* =========================
   GET TRANSACTIONS (ORDERS) - ADMIN
========================= */
app.get("/api/transactions", (req, res) => {
    const sql = `
        SELECT 
            o.id,
            o.product_id,
            o.buyer_id,
            o.price as base_price,
            o.tariff as service_fee,
            o.total_price,
            o.quantity,
            o.status,
            o.order_date as created_at,
            p.name AS product_name,
            u.fullname AS buyer_name,
            f.fullname AS farmer_name
        FROM orders o
        JOIN products p ON o.product_id = p.id
        JOIN users u ON o.buyer_id = u.id
        JOIN users f ON p.farmer_id = f.id
        ORDER BY o.order_date DESC
    `;

    db.query(sql, (err, result) => {
        if (err) {
            console.error('Error fetching transactions:', err);
            return res.status(500).json({ message: "Error fetching transactions", error: err.message });
        }
        res.json(result);
    });
});

/* =========================
   GET FARMER ORDERS
========================= */
app.get("/api/farmer-orders/:farmerId", (req, res) => {
    const farmerId = req.params.farmerId;
    
    const sql = `
        SELECT 
            o.id,
            o.product_id,
            o.buyer_id,
            o.price,
            o.tariff,
            o.total_price,
            o.quantity,
            o.status,
            o.order_date,
            p.name as product_name,
            u.fullname as buyer_name
        FROM orders o
        JOIN products p ON o.product_id = p.id
        JOIN users u ON o.buyer_id = u.id
        WHERE p.farmer_id = ?
        ORDER BY o.order_date DESC
    `;
    
    db.query(sql, [farmerId], (err, result) => {
        if (err) {
            console.error('Error fetching farmer orders:', err);
            return res.status(500).json({ message: "Error fetching orders", error: err.message });
        }
        res.json(result);
    });
});

/* =========================
   UPDATE ORDER STATUS
========================= */
app.put("/api/update-order-status", (req, res) => {
    const { order_id, status } = req.body;
    
    const sql = "UPDATE orders SET status = ? WHERE id = ?";
    
    db.query(sql, [status, order_id], (err, result) => {
        if (err) {
            console.error('Error updating order status:', err);
            return res.status(500).json({ message: "Error updating order status", error: err.message });
        }
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "Order not found" });
        }
        
        res.json({ message: "Order status updated successfully" });
    });
});

/* =========================
   GET BUYER ORDERS
========================= */
app.get("/api/buyer-orders/:buyerId", (req, res) => {
    const buyerId = req.params.buyerId;
    
    const sql = `
        SELECT 
            o.id,
            o.product_id,
            o.buyer_id,
            o.price as base_price,
            o.tariff as service_fee,
            o.total_price,
            o.quantity,
            o.status,
            o.order_date as created_at,
            p.name as product_name,
            p.image,
            u.fullname as farmer_name,
            p.quantity as available_quantity
        FROM orders o
        JOIN products p ON o.product_id = p.id
        JOIN users u ON p.farmer_id = u.id
        WHERE o.buyer_id = ?
        ORDER BY o.order_date DESC
    `;
    
    db.query(sql, [buyerId], (err, result) => {
        if (err) {
            console.error('Error fetching buyer orders:', err);
            return res.status(500).json({ message: "Error fetching orders", error: err.message });
        }
        
        // Add image URLs
        const ordersWithUrls = result.map(order => ({
            ...order,
            image_url: order.image ? `http://localhost:3000/uploads/${order.image}` : null
        }));
        
        res.json(ordersWithUrls);
    });
});

/* =========================
   UPDATE USER PROFILE
========================= */
app.put("/api/update-profile", (req, res) => {
    const { user_id, fullname, phone, location } = req.body;
    
    // First check if phone and location columns exist, if not, we'll add them
    const checkColumns = `
        SELECT COUNT(*) as count 
        FROM information_schema.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'users' 
        AND COLUMN_NAME IN ('phone', 'location')
    `;
    
    db.query(checkColumns, (err, columnResult) => {
        if (err) {
            console.error('Error checking columns:', err);
            // Continue without phone/location if columns don't exist
            const sql = "UPDATE users SET fullname = ? WHERE id = ?";
            db.query(sql, [fullname, user_id], (err, result) => {
                if (err) {
                    console.error(err);
                    return res.status(500).json({ message: "Error updating profile" });
                }
                res.json({ message: "Profile updated successfully" });
            });
        } else {
            const hasPhoneLocation = columnResult[0].count === 2;
            let sql;
            let params;
            
            if (hasPhoneLocation) {
                sql = "UPDATE users SET fullname = ?, phone = ?, location = ? WHERE id = ?";
                params = [fullname, phone || null, location || null, user_id];
            } else {
                sql = "UPDATE users SET fullname = ? WHERE id = ?";
                params = [fullname, user_id];
            }
            
            db.query(sql, params, (err, result) => {
                if (err) {
                    console.error(err);
                    return res.status(500).json({ message: "Error updating profile" });
                }
                res.json({ message: "Profile updated successfully" });
            });
        }
    });
});

/* =========================
   CHANGE PASSWORD
========================= */
app.put("/api/change-password", async (req, res) => {
    const { user_id, current_password, new_password } = req.body;
    
    // First, get the current user's password
    const getUserSql = "SELECT password FROM users WHERE id = ?";
    
    db.query(getUserSql, [user_id], async (err, result) => {
        if (err || result.length === 0) {
            return res.status(404).json({ message: "User not found" });
        }
        
        const user = result[0];
        const isValid = await bcrypt.compare(current_password, user.password);
        
        if (!isValid) {
            return res.status(401).json({ message: "Current password is incorrect" });
        }
        
        // Hash the new password
        const hashedPassword = await bcrypt.hash(new_password, 10);
        
        // Update the password
        const updateSql = "UPDATE users SET password = ? WHERE id = ?";
        db.query(updateSql, [hashedPassword, user_id], (err, result) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ message: "Error changing password" });
            }
            res.json({ message: "Password changed successfully" });
        });
    });
});

/* =========================
   DELETE ACCOUNT
========================= */
app.delete("/api/delete-account", async (req, res) => {
    const { user_id, password } = req.body;
    
    // Verify password first
    const getUserSql = "SELECT password FROM users WHERE id = ?";
    
    db.query(getUserSql, [user_id], async (err, result) => {
        if (err || result.length === 0) {
            return res.status(404).json({ message: "User not found" });
        }
        
        const user = result[0];
        const isValid = await bcrypt.compare(password, user.password);
        
        if (!isValid) {
            return res.status(401).json({ message: "Incorrect password" });
        }
        
        // Delete all products associated with this farmer
        const deleteProductsSql = "DELETE FROM products WHERE farmer_id = ?";
        db.query(deleteProductsSql, [user_id], (err) => {
            if (err) {
                console.error('Error deleting products:', err);
            }
            
            // Delete all orders associated with this user (as buyer)
            const deleteOrdersSql = "DELETE FROM orders WHERE buyer_id = ?";
            db.query(deleteOrdersSql, [user_id], (err) => {
                if (err) {
                    console.error('Error deleting orders:', err);
                }
                
                // Delete the user account
                const deleteUserSql = "DELETE FROM users WHERE id = ?";
                db.query(deleteUserSql, [user_id], (err) => {
                    if (err) {
                        console.error(err);
                        return res.status(500).json({ message: "Error deleting account" });
                    }
                    res.json({ message: "Account deleted successfully" });
                });
            });
        });
    });
});

/* =========================
   GET FARMER PRODUCTS
========================= */
app.get("/api/farmer-products/:farmerId", (req, res) => {
    const farmerId = req.params.farmerId;
    
    const sql = "SELECT * FROM products WHERE farmer_id = ? ORDER BY id DESC";
    
    db.query(sql, [farmerId], (err, results) => {
        if (err) {
            console.error('Error fetching farmer products:', err);
            return res.status(500).json({ message: "Error fetching products" });
        }
        
        // Add full URL for each image
        const productsWithUrls = results.map(product => ({
            ...product,
            image_url: product.image ? `http://localhost:3000/uploads/${product.image}` : null
        }));
        
        res.json(productsWithUrls);
    });
});

/* =========================
   DELETE FARMER PRODUCT
========================= */
app.delete("/api/farmer-products/:productId", (req, res) => {
    const productId = req.params.productId;
    
    const sql = "DELETE FROM products WHERE id = ?";
    
    db.query(sql, [productId], (err, result) => {
        if (err) {
            console.error('Error deleting product:', err);
            return res.status(500).json({ message: "Error deleting product" });
        }
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "Product not found" });
        }
        
        res.json({ message: "Product deleted successfully" });
    });
});

/* =========================
   UPDATE FARMER PRODUCT
========================= */
app.put("/api/farmer-products/:productId", upload.single("image"), (req, res) => {
    const productId = req.params.productId;
    const { name, category, price, quantity, description } = req.body;
    const image = req.file ? req.file.filename : null;
    
    let sql;
    let params;
    
    if (image) {
        sql = `
            UPDATE products 
            SET name = ?, category = ?, price = ?, quantity = ?, description = ?, image = ?
            WHERE id = ?
        `;
        params = [name, category, price, quantity, description, image, productId];
    } else {
        sql = `
            UPDATE products 
            SET name = ?, category = ?, price = ?, quantity = ?, description = ?
            WHERE id = ?
        `;
        params = [name, category, price, quantity, description, productId];
    }
    
    db.query(sql, params, (err, result) => {
        if (err) {
            console.error('Error updating product:', err);
            return res.status(500).json({ message: "Error updating product" });
        }
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "Product not found" });
        }
        
        res.json({ message: "Product updated successfully" });
    });
});

/* =========================
   GET SINGLE PRODUCT BY ID
========================= */
app.get("/api/product/:id", (req, res) => {
    const productId = req.params.id;
    const sql = "SELECT * FROM products WHERE id = ?";
    
    db.query(sql, [productId], (err, results) => {
        if (err) {
            console.error('Error fetching product:', err);
            return res.status(500).json({ message: "Error fetching product" });
        }
        
        if (results.length === 0) {
            return res.status(404).json({ message: "Product not found" });
        }
        
        const product = results[0];
        product.image_url = product.image ? `http://localhost:3000/uploads/${product.image}` : null;
        
        res.json(product);
    });
});

/* =========================
   UPDATE SITE SETTINGS
========================= */
app.put("/api/settings", (req, res) => {
    const { siteTitle, contactEmail, phone, serviceFeePercent, currency, maintenanceMode } = req.body;

    const sql = `
        UPDATE site_settings 
        SET siteTitle=?, contactEmail=?, phone=?, serviceFeePercent=?, currency=?, maintenanceMode=?
        WHERE id = 1
    `;

    db.query(sql, [
        siteTitle,
        contactEmail,
        phone,
        serviceFeePercent,
        currency,
        maintenanceMode ? 1 : 0
    ], (err) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error saving settings" });
        }

        // 🔥 GET UPDATED SETTINGS
        db.query("SELECT * FROM site_settings WHERE id = 1", (err, result) => {
            if (err || result.length === 0) {
                return res.json({ message: "Saved, but failed to fetch updated settings" });
            }

            const dbSettings = result[0];

            // ✅ NORMALIZE DATA FOR FRONTEND
            const settings = {
                siteTitle: dbSettings.siteTitle,
                contactEmail: dbSettings.contactEmail,
                phone: dbSettings.phone,
                serviceFeePercent: dbSettings.serviceFeePercent,
                currency: dbSettings.currency,
                maintenanceMode: dbSettings.maintenanceMode === 1
            };

            // 🔥 BROADCAST TO ALL USERS
            broadcastSettingsUpdate(settings);

            res.json({
                message: "✅ Settings updated",
                settings
            });
        });
    });
});

/* =========================
   GET SITE SETTINGS
========================= */
app.get("/api/settings", (req, res) => {
    const sql = "SELECT * FROM site_settings WHERE id = 1";

    db.query(sql, (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error fetching settings" });
        }

        if (result && result.length > 0) {
            res.json(result[0]);
        } else {
            // Return default settings if none exist
            const defaultSettings = {
                id: 1,
                siteTitle: "AgriHub",
                contactEmail: "admin@agrihub.com",
                phone: "+254700000000",
                serviceFeePercent: 10,
                currency: "KSH",
                maintenanceMode: false
            };
            res.json(defaultSettings);
        }
    });
});

// Start server with WebSocket support
server.listen(3000, () => {
    console.log("✅ Server running on port 3000 with WebSocket support");
    console.log("📍 API available at http://localhost:3000");
    console.log("🔌 WebSocket ready for real-time updates");
});