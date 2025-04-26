const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Création du serveur HTTP pour Socket.IO
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server);

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use(fileUpload({
    createParentPath: true,
    limits: { 
        fileSize: 50 * 1024 * 1024 // 50MB max file size
    },
}));

// Chemins des fichiers
const DB_FILE = path.join(__dirname, 'data', 'database.json');
const MEDIA_DIR = path.join(__dirname, 'public', 'media');

// Assurer que les répertoires existent
ensureDirectoryExists(path.join(__dirname, 'data'));
ensureDirectoryExists(MEDIA_DIR);

// Fonction pour créer un répertoire s'il n'existe pas
function ensureDirectoryExists(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

// Initialisation de la base de données si elle n'existe pas encore
if (!fs.existsSync(DB_FILE)) {
    const initialData = {
        users: [
            { id: 1, name: "test", email: "test", password: "test" },
            { id: 2, name: "testt", email: "testt", password: "testt" }
        ],
        contacts: [
            { userId: 1, contactId: 2 },
            { userId: 2, contactId: 1 }
        ],
        messages: []
    };
    
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
}

// Fonction pour lire la base de données
function readDatabase() {
    try {
        const data = fs.readFileSync(DB_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error("Erreur lors de la lecture de la base de données:", error);
        return null;
    }
}

// Fonction pour écrire dans la base de données
function writeDatabase(data) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error("Erreur lors de l'écriture dans la base de données:", error);
        return false;
    }
}

// Gestion des connexions Socket.IO
const userSockets = {}; // Pour suivre les sockets des utilisateurs connectés
const typingUsers = {}; // Pour suivre les utilisateurs en train d'écrire

io.on('connection', (socket) => {
    console.log('Un utilisateur s\'est connecté');
    
    // L'utilisateur s'authentifie
    socket.on('userConnected', (userId) => {
        userSockets[userId] = socket.id;
        console.log(`Utilisateur ${userId} connecté avec socket ${socket.id}`);
    });
    
    // Réception d'un nouveau message
    socket.on('newMessage', (message) => {
        console.log('Nouveau message reçu:', message);
        
        // Sauvegarder le message dans la base de données
        const db = readDatabase();
        message.id = db.messages.length + 1;
        message.timestamp = new Date().getTime();
        db.messages.push(message);
        writeDatabase(db);
        
        // Envoyer le message au destinataire si connecté
        const receiverSocketId = userSockets[message.receiverId];
        if (receiverSocketId) {
            io.to(receiverSocketId).emit('messageReceived', message);
        }
        
        // Supprimer l'état de frappe de l'utilisateur une fois qu'il a envoyé un message
        if (typingUsers[message.senderId]) {
            delete typingUsers[message.senderId];
            // Informer le destinataire que l'utilisateur ne tape plus
            if (receiverSocketId) {
                io.to(receiverSocketId).emit('userStoppedTyping', message.senderId);
            }
        }
    });
    
    // L'utilisateur commence à écrire
    socket.on('startTyping', (data) => {
        const { userId, receiverId } = data;
        typingUsers[userId] = { receiverId, timestamp: Date.now() };
        
        // Informer le destinataire que l'utilisateur est en train d'écrire
        const receiverSocketId = userSockets[receiverId];
        if (receiverSocketId) {
            io.to(receiverSocketId).emit('userTyping', userId);
        }
    });
    
    // L'utilisateur arrête d'écrire
    socket.on('stopTyping', (data) => {
        const { userId, receiverId } = data;
        delete typingUsers[userId];
        
        // Informer le destinataire que l'utilisateur a arrêté d'écrire
        const receiverSocketId = userSockets[receiverId];
        if (receiverSocketId) {
            io.to(receiverSocketId).emit('userStoppedTyping', userId);
        }
    });
    
    // Déconnexion d'un utilisateur
    socket.on('disconnect', () => {
        console.log('Un utilisateur s\'est déconnecté');
        // Supprimer le socket de la liste des utilisateurs connectés
        for (const userId in userSockets) {
            if (userSockets[userId] === socket.id) {
                // Supprimer également l'état de frappe
                if (typingUsers[userId]) {
                    const receiverId = typingUsers[userId].receiverId;
                    delete typingUsers[userId];
                    
                    // Informer le destinataire que l'utilisateur ne tape plus
                    const receiverSocketId = userSockets[receiverId];
                    if (receiverSocketId) {
                        io.to(receiverSocketId).emit('userStoppedTyping', parseInt(userId));
                    }
                }
                
                delete userSockets[userId];
                console.log(`Utilisateur ${userId} déconnecté`);
                break;
            }
        }
    });
});

// Nettoyer les indicateurs de frappe périmés (après 5 secondes d'inactivité)
setInterval(() => {
    const now = Date.now();
    for (const userId in typingUsers) {
        if (now - typingUsers[userId].timestamp > 5000) {
            const receiverId = typingUsers[userId].receiverId;
            delete typingUsers[userId];
            
            // Informer le destinataire que l'utilisateur ne tape plus
            const receiverSocketId = userSockets[receiverId];
            if (receiverSocketId) {
                io.to(receiverSocketId).emit('userStoppedTyping', parseInt(userId));
            }
        }
    }
}, 1000);

// Routes API
// Récupérer la base de données
app.get('/api/database', (req, res) => {
    const data = readDatabase();
    if (data) {
        res.json(data);
    } else {
        res.status(500).json({ error: "Erreur lors de la lecture de la base de données" });
    }
});

// Mettre à jour la base de données
app.post('/api/database', (req, res) => {
    const success = writeDatabase(req.body);
    if (success) {
        res.json({ success: true });
    } else {
        res.status(500).json({ error: "Erreur lors de l'écriture dans la base de données" });
    }
});

// Upload de médias
app.post('/api/upload', (req, res) => {
    if (!req.files || !req.files.media) {
        return res.status(400).json({ error: "Aucun fichier n'a été uploadé" });
    }
    
    const userId = req.body.userId;
    if (!userId) {
        return res.status(400).json({ error: "ID utilisateur manquant" });
    }
    
    // Créer un répertoire pour l'utilisateur s'il n'existe pas
    const userMediaDir = path.join(MEDIA_DIR, userId.toString());
    ensureDirectoryExists(userMediaDir);
    
    const file = req.files.media;
    const fileName = `${Date.now()}_${file.name}`;
    const filePath = path.join(userMediaDir, fileName);
    
    try {
        // Déplacer le fichier vers le répertoire de l'utilisateur
        file.mv(filePath, (err) => {
            if (err) {
                console.error("Erreur lors du déplacement du fichier:", err);
                return res.status(500).json({ error: "Erreur lors de l'upload du fichier" });
            }
            
            // Renvoyer le chemin du fichier relatif au dossier public
            const relativePath = `/media/${userId}/${fileName}`;
            res.json({ success: true, filePath: relativePath });
        });
    } catch (error) {
        console.error("Erreur lors de l'upload du fichier:", error);
        res.status(500).json({ error: "Erreur lors de l'upload du fichier" });
    }
});

// Route pour servir le fichier HTML principal
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Démarrer le serveur
server.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
});