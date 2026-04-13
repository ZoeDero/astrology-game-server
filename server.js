const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const Redis = require('@upstash/redis').Redis;

const app = express();

// CORS simple pour Railway
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: false
  },
  transports: ['polling', 'websocket'],
  pingTimeout: 30000,
  pingInterval: 10000
});

// Redis client pour stocker les salles (persistance)
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const ROOM_PREFIX = 'room:';
const ROOM_TTL = 60 * 60; // 1 heure
const USER_PREFIX = 'user:';
const DECK_PREFIX = 'deck:';
const STATS_PREFIX = 'stats:';

// Fonctions helper pour Redis - Salles
async function getRoom(roomId) {
  const room = await redis.get(`${ROOM_PREFIX}${roomId.toUpperCase()}`);
  return room ? JSON.parse(room) : null;
}

async function setRoom(roomId, room) {
  await redis.set(`${ROOM_PREFIX}${roomId.toUpperCase()}`, JSON.stringify(room), { ex: ROOM_TTL });
}

async function deleteRoom(roomId) {
  await redis.del(`${ROOM_PREFIX}${roomId.toUpperCase()}`);
}

// Fonctions helper pour Redis - Utilisateurs
async function getUser(username) {
  const user = await redis.hgetall(`${USER_PREFIX}${username.toLowerCase()}`);
  return Object.keys(user).length > 0 ? user : null;
}

async function createUser(username, passwordHash) {
  await redis.hset(`${USER_PREFIX}${username.toLowerCase()}`, {
    username: username,
    password: passwordHash,
    createdAt: Date.now()
  });
  // Initialiser les stats
  await redis.hset(`${STATS_PREFIX}${username.toLowerCase()}`, {
    wins: 0,
    losses: 0,
    draws: 0,
    gamesPlayed: 0
  });
}

async function getUserStats(username) {
  const stats = await redis.hgetall(`${STATS_PREFIX}${username.toLowerCase()}`);
  return stats || { wins: 0, losses: 0, draws: 0, gamesPlayed: 0 };
}

async function updateUserStats(username, result) {
  const key = `${STATS_PREFIX}${username.toLowerCase()}`;
  await redis.hincrby(key, 'gamesPlayed', 1);
  if (result === 'win') {
    await redis.hincrby(key, 'wins', 1);
  } else if (result === 'loss') {
    await redis.hincrby(key, 'losses', 1);
  } else if (result === 'draw') {
    await redis.hincrby(key, 'draws', 1);
  }
}

async function saveDeck(username, deckName, deckData) {
  await redis.set(`${DECK_PREFIX}${username.toLowerCase()}:${deckName}`, JSON.stringify(deckData));
}

async function getDecks(username) {
  const keys = await redis.keys(`${DECK_PREFIX}${username.toLowerCase()}:*`);
  const decks = {};
  for (const key of keys) {
    const deckName = key.split(':').pop();
    const deck = await redis.get(key);
    if (deck) {
      decks[deckName] = JSON.parse(deck);
    }
  }
  return decks;
}

// Routes API pour les comptes
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username et password requis' });
  }
  
  // Vérifier si l'utilisateur existe déjà
  const existingUser = await getUser(username);
  if (existingUser) {
    return res.status(409).json({ error: 'Ce pseudo existe déjà' });
  }
  
  // Créer l'utilisateur (simple hash pour l'instant)
  const crypto = require('crypto');
  const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
  
  await createUser(username, passwordHash);
  
  res.json({ success: true, message: 'Compte créé avec succès' });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username et password requis' });
  }
  
  const user = await getUser(username);
  if (!user) {
    return res.status(401).json({ error: 'Pseudo ou mot de passe incorrect' });
  }
  
  const crypto = require('crypto');
  const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
  
  if (user.password !== passwordHash) {
    return res.status(401).json({ error: 'Pseudo ou mot de passe incorrect' });
  }
  
  // Récupérer les stats
  const stats = await getUserStats(username);
  
  res.json({ 
    success: true, 
    username: user.username,
    stats: stats
  });
});

app.get('/api/stats/:username', async (req, res) => {
  const stats = await getUserStats(req.params.username);
  res.json(stats);
});

app.post('/api/deck/save', async (req, res) => {
  const { username, deckName, deckData } = req.body;
  await saveDeck(username, deckName, deckData);
  res.json({ success: true });
});

app.get('/api/decks/:username', async (req, res) => {
  const decks = await getDecks(req.params.username);
  res.json(decks);
});

// Nettoyer les salles inactives (Redis gère le TTL automatiquement)

io.on('connection', (socket) => {
  console.log('Nouveau client connecté:', socket.id, 'Transport:', socket.conn.transport.name);
  
  socket.on('disconnect', (reason) => {
    console.log('Client déconnecté:', socket.id, 'Raison:', reason);
  });
  
  socket.on('error', (err) => {
    console.error('Erreur socket:', socket.id, err);
  });

  // Créer une salle
  socket.on('createRoom', async ({ playerName }) => {
    const roomId = uuidv4().substr(0, 8).toUpperCase();
    
    const room = {
      id: roomId,
      host: socket.id,
      players: [{
        id: socket.id,
        isHost: true,
        ready: false,
        name: playerName || 'Joueur 1'
      }],
      gameState: null,
      createdAt: Date.now()
    };
    
    await setRoom(roomId, room);
    
    socket.join(roomId);
    socket.emit('roomCreated', { roomId, isHost: true, playerName: playerName || 'Joueur 1' });
    console.log(`Salle créée: ${roomId} par ${socket.id} (${playerName || 'Joueur 1'})`);
  });

  // Rejoindre une salle
  socket.on('joinRoom', async ({ roomId, playerName }) => {
    const room = await getRoom(roomId);
    
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
      ready: false,
      name: playerName || 'Joueur 2'
    });
    
    // Sauvegarder la salle mise à jour
    await setRoom(roomId, room);
    
    const joiningPlayer = room.players.find(p => p.id === socket.id);
    
    socket.join(roomId);
    socket.emit('roomJoined', { 
      roomId, 
      isHost: false, 
      playerName: joiningPlayer?.name || 'Joueur 2',
      opponentName: room.players[0]?.name || 'Joueur 1'
    });
    
    // Notifier l'hôte
    socket.to(roomId).emit('playerJoined', {
      playerId: socket.id,
      playerName: joiningPlayer?.name || 'Joueur 2',
      playersCount: room.players.length
    });
    
    console.log(`Joueur ${socket.id} (${joiningPlayer?.name}) a rejoint ${roomId}`);
    
    // Si 2 joueurs, démarrer la partie avec les noms
    if (room.players.length === 2) {
      const hostPlayer = room.players[0];
      const guestPlayer = room.players[1];
      io.to(roomId).emit('gameReady', {
        hostName: hostPlayer?.name || 'Joueur 1',
        guestName: guestPlayer?.name || 'Joueur 2'
      });
    }
  });

  // Définir prêt
  socket.on('setReady', async ({ roomId, ready }) => {
    const room = await getRoom(roomId);
    if (!room) return;
    
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.ready = ready;
    }
    
    // Sauvegarder
    await setRoom(roomId, room);
    
    const allReady = room.players.every(p => p.ready);
    if (allReady && room.players.length === 2) {
      io.to(roomId).emit('gameStart');
    }
    
    socket.to(roomId).emit('playerReady', { playerId: socket.id, ready });
  });

  // Mettre à jour l'état du jeu
  socket.on('updateGameState', async ({ roomId, gameState }) => {
    const room = await getRoom(roomId);
    if (!room) return;
    
    room.gameState = gameState;
    await setRoom(roomId, room);
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
  socket.on('disconnect', async () => {
    console.log('Client déconnecté:', socket.id);
    
    // Note: Redis ne permet pas de facilement chercher toutes les clés
    // Les salles expireront automatiquement après 1 heure (TTL)
    // Le joueur déconnecté sera simplement marqué comme absent
  });
});

// Health check
app.get('/', async (req, res) => {
  // Compter les salles dans Redis
  const keys = await redis.keys(`${ROOM_PREFIX}*`);
  res.json({ 
    status: 'OK', 
    rooms: keys.length,
    uptime: process.uptime()
  });
});

// Liste des salles (debug)
app.get('/rooms', async (req, res) => {
  const keys = await redis.keys(`${ROOM_PREFIX}*`);
  const roomsList = [];
  for (const key of keys) {
    const room = await redis.get(key);
    if (room) {
      const roomData = JSON.parse(room);
      roomsList.push({
        id: roomData.id,
        players: roomData.players.length,
        createdAt: roomData.createdAt
      });
    }
  }
  res.json(roomsList);
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/`);
});
