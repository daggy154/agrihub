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

app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(cors());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use(express.static("public"));
app.use("/uploads", express.static("uploads"));

// WebSocket connection handling
const connectedClients = new Set();

io.on('connection', (socket) => {
  console.log('🟢 Client connected:', socket.id);
  connectedClients.add(socket);
  socket.on('disconnect', () => {
    connectedClients.delete(socket);
    console.log('🔴 Client disconnected:', socket.id);
  });
});

function broadcastSettingsUpdate(settings) {
  io.emit('settingsUpdated', settings);
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
   REGISTER USER (WITH ADDRESS)
========================= */
app.post("/register", async (req, res) => {
    const { fullname, email, password, role, phone, address } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);

    // Ensure phone and address columns exist
    const addPhoneColumn = "ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20) DEFAULT NULL";
    const addAddressColumn = "ALTER TABLE users ADD COLUMN IF NOT EXISTS address TEXT DEFAULT NULL";
    
    db.query(addPhoneColumn, (err) => {
        if (err) console.error('Error adding phone column:', err);
    });
    db.query(addAddressColumn, (err) => {
        if (err) console.error('Error adding address column:', err);
    });

    const sql = "INSERT INTO users(fullname, email, password, role, phone, address) VALUES(?,?,?,?,?,?)";

    db.query(sql, [fullname, email, hashedPassword, role, phone || null, address || null], (err, result) => {
        if (err) {
            console.error('Registration error:', err);
            return res.json({ message: "Email already exists" });
        }

        const userId = result.insertId;
        const userData = {
            id: userId,
            fullname: fullname,
            email: email,
            role: role,
            phone: phone || null,
            address: address || null
        };

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
app.post("/login", (req, res) => {
    const { email, password } = req.body;

    const sql = "SELECT * FROM users WHERE email=?";

    db.query(sql, [email], async (err, result) => {
        if (result.length === 0) {
            return res.json({ message: "User not found" });
        }

        const user = result[0];
        const match = await bcrypt.compare(password, user.password);

        if (!match) {
            return res.json({ message: "Incorrect password" });
        }

        const userData = {
            id: user.id,
            fullname: user.fullname,
            email: user.email,
            role: user.role,
            phone: user.phone || '',
            address: user.address || ''
        };

        let redirectPath = "";
        if (user.role === "seller") {
            redirectPath = "farmer_dashboard.html";
        } else if (user.role === "buyer") {
            redirectPath = "buyer_dashboard.html";
        } else {
            redirectPath = "admin_control_panel.html";
        }

        res.json({
            redirect: redirectPath,
            user: userData
        });
    });
});

/* =========================
   ADD PRODUCT (FARMER)
========================= */
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
   BUY PRODUCT (WITH DYNAMIC SERVICE FEE)
========================= */
app.post("/buy-product", (req, res) => {
    const { product_id, buyer_id, total_price, quantity, base_price, service_fee_percent } = req.body;
    
    if (!product_id || !buyer_id || !quantity || quantity <= 0) {
        return res.status(400).json({ message: 'Invalid purchase data' });
    }
    
    db.beginTransaction((err) => {
        if (err) {
            console.error('Transaction error:', err);
            return res.status(500).json({ message: "Transaction error" });
        }
        
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
            
            if (currentProduct.quantity < quantity) {
                return db.rollback(() => {
                    res.status(400).json({ 
                        message: `Insufficient quantity. Only ${currentProduct.quantity} available`,
                        available: currentProduct.quantity
                    });
                });
            }
            
            const basePriceValue = base_price || currentProduct.price;
            let serviceFeePercent = service_fee_percent || 10;
            
            const getSettingsSql = "SELECT serviceFeePercent FROM site_settings WHERE id = 1";
            db.query(getSettingsSql, (err, settingsResult) => {
                if (!err && settingsResult && settingsResult.length > 0) {
                    serviceFeePercent = settingsResult[0].serviceFeePercent || 10;
                }
                
                const serviceFee = basePriceValue * quantity * (serviceFeePercent / 100);
                const totalPriceValue = total_price || (basePriceValue * quantity + serviceFee);
                
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
                    
                    const newQuantity = currentProduct.quantity - quantity;
                    const updateProductSql = "UPDATE products SET quantity = ? WHERE id = ?";
                    
                    db.query(updateProductSql, [newQuantity, product_id], (err, updateResult) => {
                        if (err) {
                            return db.rollback(() => {
                                console.error('Error updating product quantity:', err);
                                res.status(500).json({ message: "Error updating product quantity" });
                            });
                        }
                        
                        db.commit((err) => {
                            if (err) {
                                return db.rollback(() => {
                                    console.error('Error committing transaction:', err);
                                    res.status(500).json({ message: "Transaction commit error" });
                                });
                            }
                            
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
   GET PRODUCTS WITH IMAGE URLS
========================= */
app.get("/api/products", (req, res) => {
    const sql = "SELECT * FROM products ORDER BY id DESC";
    
    db.query(sql, (err, results) => {
        if (err) {
            console.log(err);
            return res.status(500).json({ error: "Database error" });
        }
        
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
   GET ALL USERS WITH PHONE AND ADDRESS (ADMIN)
========================= */
app.get("/api/users", (req, res) => {
    const sql = "SELECT id, fullname, email, phone, address, role FROM users";
    
    db.query(sql, (err, result) => {
        if (err) {
            console.error('Error fetching users:', err);
            return res.status(500).json({ message: "Error fetching users" });
        }
        console.log('Users fetched with phone/address:', result.length);
        res.json(result);
    });
});

/* =========================
   UPDATE USER (ADMIN) - WITH PHONE AND ADDRESS
========================= */
app.put("/api/users/:id", async (req, res) => {
    const userId = req.params.id;
    const { fullname, email, phone, address, role, password } = req.body;
    
    console.log('Updating user:', { userId, fullname, email, phone, address, role });
    
    let sql;
    let params;
    
    if (password && password.trim() !== '') {
        const hashedPassword = await bcrypt.hash(password, 10);
        sql = `UPDATE users SET 
                fullname = ?, 
                email = ?, 
                phone = ?, 
                address = ?, 
                role = ?, 
                password = ? 
                WHERE id = ?`;
        params = [fullname, email, phone || null, address || null, role, hashedPassword, userId];
    } else {
        sql = `UPDATE users SET 
                fullname = ?, 
                email = ?, 
                phone = ?, 
                address = ?, 
                role = ? 
                WHERE id = ?`;
        params = [fullname, email, phone || null, address || null, role, userId];
    }
    
    db.query(sql, params, (err, result) => {
        if (err) {
            console.error('Error updating user:', err);
            return res.status(500).json({ message: "Error updating user", error: err.message });
        }
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "User not found" });
        }
        
        console.log('User updated successfully:', userId);
        res.json({ message: "User updated successfully" });
    });
});

/* =========================
   DELETE USER (ADMIN) - WITH CASCADE HANDLING
========================= */
app.delete("/api/users/:id", (req, res) => {
    const userId = req.params.id;
    
    // First, check if user exists
    const checkUserSql = "SELECT role FROM users WHERE id = ?";
    
    db.query(checkUserSql, [userId], (err, userResult) => {
        if (err) {
            console.error('Error checking user:', err);
            return res.status(500).json({ message: "Error checking user" });
        }
        
        if (userResult.length === 0) {
            return res.status(404).json({ message: "User not found" });
        }
        
        const userRole = userResult[0].role;
        
        // Start a transaction
        db.beginTransaction((err) => {
            if (err) {
                console.error('Transaction error:', err);
                return res.status(500).json({ message: "Transaction error" });
            }
            
            // If user is a farmer/seller, delete their products first
            if (userRole === 'seller' || userRole === 'farmer') {
                const deleteProductsSql = "DELETE FROM products WHERE farmer_id = ?";
                
                db.query(deleteProductsSql, [userId], (err, productResult) => {
                    if (err) {
                        return db.rollback(() => {
                            console.error('Error deleting products:', err);
                            res.status(500).json({ message: "Error deleting user's products" });
                        });
                    }
                    
                    // Delete orders related to this user (as buyer)
                    const deleteOrdersSql = "DELETE FROM orders WHERE buyer_id = ?";
                    db.query(deleteOrdersSql, [userId], (err, orderResult) => {
                        if (err) {
                            return db.rollback(() => {
                                console.error('Error deleting orders:', err);
                                res.status(500).json({ message: "Error deleting user's orders" });
                            });
                        }
                        
                        // Now delete the user
                        const deleteUserSql = "DELETE FROM users WHERE id = ?";
                        db.query(deleteUserSql, [userId], (err, userDeleteResult) => {
                            if (err) {
                                return db.rollback(() => {
                                    console.error('Error deleting user:', err);
                                    res.status(500).json({ message: "Error deleting user" });
                                });
                            }
                            
                            if (userDeleteResult.affectedRows === 0) {
                                return db.rollback(() => {
                                    res.status(404).json({ message: "User not found" });
                                });
                            }
                            
                            // Commit the transaction
                            db.commit((err) => {
                                if (err) {
                                    return db.rollback(() => {
                                        console.error('Error committing transaction:', err);
                                        res.status(500).json({ message: "Error committing transaction" });
                                    });
                                }
                                
                                res.json({ 
                                    message: "User and all associated data deleted successfully",
                                    deletedProducts: productResult?.affectedRows || 0,
                                    deletedOrders: orderResult?.affectedRows || 0
                                });
                            });
                        });
                    });
                });
            } else {
                // For buyers or admins, just delete orders and user
                const deleteOrdersSql = "DELETE FROM orders WHERE buyer_id = ?";
                db.query(deleteOrdersSql, [userId], (err, orderResult) => {
                    if (err) {
                        return db.rollback(() => {
                            console.error('Error deleting orders:', err);
                            res.status(500).json({ message: "Error deleting user's orders" });
                        });
                    }
                    
                    // Now delete the user
                    const deleteUserSql = "DELETE FROM users WHERE id = ?";
                    db.query(deleteUserSql, [userId], (err, userDeleteResult) => {
                        if (err) {
                            return db.rollback(() => {
                                console.error('Error deleting user:', err);
                                res.status(500).json({ message: "Error deleting user" });
                            });
                        }
                        
                        if (userDeleteResult.affectedRows === 0) {
                            return db.rollback(() => {
                                res.status(404).json({ message: "User not found" });
                            });
                        }
                        
                        db.commit((err) => {
                            if (err) {
                                return db.rollback(() => {
                                    console.error('Error committing transaction:', err);
                                    res.status(500).json({ message: "Error committing transaction" });
                                });
                            }
                            
                            res.json({ 
                                message: "User deleted successfully",
                                deletedOrders: orderResult?.affectedRows || 0
                            });
                        });
                    });
                });
            }
        });
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
        
        const ordersWithUrls = result.map(order => ({
            ...order,
            image_url: order.image ? `http://localhost:3000/uploads/${order.image}` : null
        }));
        
        res.json(ordersWithUrls);
    });
});

/* =========================
   UPDATE USER PROFILE (BUYER/FARMER) - USING ADDRESS
========================= */
app.put("/api/update-profile", (req, res) => {
    const { user_id, fullname, phone, address } = req.body;
    
    // Ensure columns exist
    const addPhoneColumn = "ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20) DEFAULT NULL";
    const addAddressColumn = "ALTER TABLE users ADD COLUMN IF NOT EXISTS address TEXT DEFAULT NULL";
    
    db.query(addPhoneColumn, (err) => {
        if (err) console.error('Error adding phone column:', err);
    });
    db.query(addAddressColumn, (err) => {
        if (err) console.error('Error adding address column:', err);
    });
    
    const sql = "UPDATE users SET fullname = ?, phone = ?, address = ? WHERE id = ?";
    const params = [fullname, phone || null, address || null, user_id];
    
    db.query(sql, params, (err, result) => {
        if (err) {
            console.error('Error updating profile:', err);
            return res.status(500).json({ message: "Error updating profile" });
        }
        res.json({ message: "Profile updated successfully" });
    });
});

/* =========================
   CHANGE PASSWORD
========================= */
app.put("/api/change-password", async (req, res) => {
    const { user_id, current_password, new_password } = req.body;
    
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
        
        const hashedPassword = await bcrypt.hash(new_password, 10);
        
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
        
        const deleteProductsSql = "DELETE FROM products WHERE farmer_id = ?";
        db.query(deleteProductsSql, [user_id], (err) => {
            if (err) console.error('Error deleting products:', err);
            
            const deleteOrdersSql = "DELETE FROM orders WHERE buyer_id = ?";
            db.query(deleteOrdersSql, [user_id], (err) => {
                if (err) console.error('Error deleting orders:', err);
                
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
   UPDATE ADMIN PROFILE
========================= */
app.put("/api/admin/profile", (req, res) => {
    const { user_id, fullname, phone } = req.body;
    
    if (!user_id) {
        return res.status(400).json({ message: "User ID is required" });
    }
    
    const sql = "UPDATE users SET fullname = ?, phone = ? WHERE id = ? AND role = 'admin'";
    
    db.query(sql, [fullname, phone, user_id], (err, result) => {
        if (err) {
            console.error('Error updating admin profile:', err);
            return res.status(500).json({ message: "Error updating profile" });
        }
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: "Admin user not found" });
        }
        
        const updateSettingsSql = "UPDATE site_settings SET admin_phone = ? WHERE id = 1";
        db.query(updateSettingsSql, [phone], (err) => {
            if (err) console.error('Error updating admin phone in settings:', err);
            
            const getSettingsSql = "SELECT * FROM site_settings WHERE id = 1";
            db.query(getSettingsSql, (err, settingsResult) => {
                if (!err && settingsResult && settingsResult.length > 0) {
                    const settings = {
                        siteTitle: settingsResult[0].siteTitle,
                        contactEmail: settingsResult[0].contactEmail,
                        phone: settingsResult[0].phone,
                        admin_phone: settingsResult[0].admin_phone,
                        serviceFeePercent: settingsResult[0].serviceFeePercent,
                        currency: settingsResult[0].currency,
                        maintenanceMode: settingsResult[0].maintenanceMode === 1
                    };
                    broadcastSettingsUpdate(settings);
                }
            });
            
            res.json({ 
                message: "Profile updated successfully",
                user: { id: user_id, fullname, phone, role: 'admin' }
            });
        });
    });
});

/* =========================
   GET ADMIN PROFILE
========================= */
app.get("/api/admin/profile/:userId", (req, res) => {
    const userId = req.params.userId;
    
    const sql = "SELECT id, fullname, email, phone, role FROM users WHERE id = ? AND role = 'admin'";
    
    db.query(sql, [userId], (err, result) => {
        if (err) {
            console.error('Error fetching admin profile:', err);
            return res.status(500).json({ message: "Error fetching profile" });
        }
        
        if (result.length === 0) {
            return res.status(404).json({ message: "Admin not found" });
        }
        
        res.json(result[0]);
    });
});

/* =========================
   GET USER PROFILE
========================= */
app.get("/api/user/profile/:userId", (req, res) => {
    const userId = req.params.userId;
    
    const sql = "SELECT id, fullname, email, phone, address FROM users WHERE id = ?";
    
    db.query(sql, [userId], (err, result) => {
        if (err) {
            console.error('Error fetching user profile:', err);
            return res.status(500).json({ message: "Error fetching profile" });
        }
        
        if (result.length === 0) {
            return res.status(404).json({ message: "User not found" });
        }
        
        res.json(result[0]);
    });
});

/* =========================
   UPDATE SITE SETTINGS
========================= */
app.put("/api/settings", (req, res) => {
    const { siteTitle, contactEmail, phone, serviceFeePercent, currency, maintenanceMode, admin_phone } = req.body;

    const finalAdminPhone = admin_phone || phone || '+254700000000';

    const sql = `
        UPDATE site_settings 
        SET siteTitle=?, contactEmail=?, phone=?, admin_phone=?, serviceFeePercent=?, currency=?, maintenanceMode=?
        WHERE id = 1
    `;

    db.query(sql, [
        siteTitle,
        contactEmail,
        phone,
        finalAdminPhone,
        serviceFeePercent,
        currency,
        maintenanceMode ? 1 : 0
    ], (err) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "Error saving settings" });
        }

        db.query("SELECT * FROM site_settings WHERE id = 1", (err, result) => {
            if (err || result.length === 0) {
                return res.json({ message: "Saved, but failed to fetch updated settings" });
            }

            const dbSettings = result[0];
            const settings = {
                siteTitle: dbSettings.siteTitle,
                contactEmail: dbSettings.contactEmail,
                phone: dbSettings.phone,
                admin_phone: dbSettings.admin_phone || dbSettings.phone,
                serviceFeePercent: dbSettings.serviceFeePercent,
                currency: dbSettings.currency,
                maintenanceMode: dbSettings.maintenanceMode === 1
            };

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
            return res.status(500).json({ message: "Error fetching settings" });
        }

        if (result && result.length > 0) {
            const s = result[0];

            res.json({
                siteTitle: s.siteTitle,
                contactEmail: s.contactEmail,
                phone: s.phone,
                admin_phone: s.admin_phone || s.phone,
                serviceFeePercent: s.serviceFeePercent,
                currency: s.currency,
                maintenanceMode: s.maintenanceMode === 1
            });
        } else {
            res.json({
                siteTitle: "AgriHub",
                contactEmail: "admin@agrihub.com",
                phone: "+2547113820053",
                admin_phone: "+2547113820053",
                serviceFeePercent: 10,
                currency: "KSH",
                maintenanceMode: false
            });
        }
    });
});

// Start server
server.listen(3000, () => {
    console.log("✅ Server running on port 3000 with WebSocket support");
    console.log("📍 API available at http://localhost:3000");
    console.log("🔌 WebSocket ready for real-time updates");
});