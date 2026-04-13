const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000
});

// Stockage des salles en mémoire
const rooms = new Map();

// Nettoyer les salles inactives (plus de 30 min)
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    if (now - room.createdAt > 30 * 60 * 1000) {
      rooms.delete(roomId);
      console.log(`Salle ${roomId} supprimée (inactif)`);
    }
  }
}, 5 * 60 * 1000);

io.on('connection', (socket) => {
  console.log('Nouveau client connecté:', socket.id);

  // Créer une salle
  socket.on('createRoom', () => {
    const roomId = uuidv4().substr(0, 8).toUpperCase();
    
    rooms.set(roomId, {
      id: roomId,
      host: socket.id,
      players: [{
        id: socket.id,
        isHost: true,
        ready: false
      }],
      gameState: null,
      createdAt: Date.now()
    });
    
    socket.join(roomId);
    socket.emit('roomCreated', { roomId, isHost: true });
    console.log(`Salle créée: ${roomId} par ${socket.id}`);
  });

  // Rejoindre une salle
  socket.on('joinRoom', (roomId) => {
    const room = rooms.get(roomId.toUpperCase());
    
    if (!room) {
      socket.emit('error', { message: 'Salle non trouvée' });
      return;
    }
    
    if (room.players.length >= 2) {
      socket.emit('error', { message: 'Salle pleine' });
      return;
    }
    
    room.players.push({
      id: socket.id,
      isHost: false,
      ready: false
    });
    
    socket.join(roomId);
    socket.emit('roomJoined', { roomId, isHost: false });
    
    // Notifier l'hôte
    socket.to(roomId).emit('playerJoined', {
      playerId: socket.id,
      playersCount: room.players.length
    });
    
    console.log(`Joueur ${socket.id} a rejoint ${roomId}`);
    
    // Si 2 joueurs, démarrer la partie
    if (room.players.length === 2) {
      io.to(roomId).emit('gameReady');
    }
  });

  // Définir prêt
  socket.on('setReady', ({ roomId, ready }) => {
    const room = rooms.get(roomId.toUpperCase());
    if (!room) return;
    
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.ready = ready;
    }
    
    const allReady = room.players.every(p => p.ready);
    if (allReady && room.players.length === 2) {
      io.to(roomId).emit('gameStart');
    }
    
    socket.to(roomId).emit('playerReady', { playerId: socket.id, ready });
  });

  // Mettre à jour l'état du jeu
  socket.on('updateGameState', ({ roomId, gameState }) => {
    const room = rooms.get(roomId.toUpperCase());
    if (!room) return;
    
    room.gameState = gameState;
    socket.to(roomId).emit('gameStateUpdated', gameState);
  });

  // Jouer une carte
  socket.on('playCard', ({ roomId, card, isPlayer }) => {
    socket.to(roomId).emit('opponentPlayedCard', { card, isPlayer });
  });

  // Fin de tour
  socket.on('endTurn', ({ roomId, currentPlayer }) => {
    socket.to(roomId).emit('turnEnded', { currentPlayer });
  });

  // Déconnexion
  socket.on('disconnect', () => {
    console.log('Client déconnecté:', socket.id);
    
    // Chercher et nettoyer les salles
    for (const [roomId, room] of rooms.entries()) {
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      
      if (playerIndex !== -1) {
        room.players.splice(playerIndex, 1);
        
        // Notifier l'autre joueur
        socket.to(roomId).emit('playerDisconnected', { playerId: socket.id });
        
        // Supprimer la salle si vide
        if (room.players.length === 0) {
          rooms.delete(roomId);
          console.log(`Salle ${roomId} supprimée (vide)`);
        }
        
        break;
      }
    }
  });
});

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'OK', 
    rooms: rooms.size,
    uptime: process.uptime()
  });
});

// Liste des salles (debug)
app.get('/rooms', (req, res) => {
  const roomsList = Array.from(rooms.values()).map(r => ({
    id: r.id,
    players: r.players.length,
    createdAt: r.createdAt
  }));
  res.json(roomsList);
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/`);
});
