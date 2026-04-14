const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const Redis = require('@upstash/redis').Redis;

const app = express();

// Middleware CORS manuel pour toutes les réponses
app.use((req, res, next) => {
  console.log('CORS middleware:', req.method, req.path);
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  if (req.method === 'OPTIONS') {
    console.log('Handling OPTIONS preflight');
    return res.sendStatus(200);
  }
  next();
});

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  credentials: false
}));

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
  try {
    const room = await redis.get(`${ROOM_PREFIX}${roomId.toUpperCase()}`);
    if (!room) return null;
    if (typeof room === 'object') return room;
    return JSON.parse(room);
  } catch (e) {
    console.error('Erreur getRoom:', e);
    return null;
  }
}

async function setRoom(roomId, room) {
  try {
    await redis.set(`${ROOM_PREFIX}${roomId.toUpperCase()}`, JSON.stringify(room), { ex: ROOM_TTL });
  } catch (e) {
    console.error('Erreur setRoom:', e);
  }
}

async function deleteRoom(roomId) {
  try {
    await redis.del(`${ROOM_PREFIX}${roomId.toUpperCase()}`);
  } catch (e) {
    console.error('Erreur deleteRoom:', e);
  }
}

// Fonctions helper pour Redis - Utilisateurs
async function getUser(username) {
  if (!redis) return null;
  try {
    const user = await redis.hgetall(`${USER_PREFIX}${username.toLowerCase()}`);
    if (!user || user === null || user === undefined) return null;
    if (typeof user !== 'object') return null;
    const keys = Object.keys(user);
    return keys.length > 0 ? user : null;
  } catch (e) {
    console.error('Erreur getUser:', e);
    return null;
  }
}

async function createUser(username, passwordHash) {
  if (!redis) return;
  try {
    await redis.hset(`${USER_PREFIX}${username.toLowerCase()}`, {
      username: username,
      password: passwordHash,
      createdAt: Date.now()
    });
    await redis.hset(`${STATS_PREFIX}${username.toLowerCase()}`, {
      wins: 0,
      losses: 0,
      draws: 0,
      gamesPlayed: 0
    });
  } catch (e) {
    console.error('Erreur createUser:', e);
  }
}

async function getUserStats(username) {
  if (!redis) return { wins: 0, losses: 0, draws: 0, gamesPlayed: 0 };
  try {
    const stats = await redis.hgetall(`${STATS_PREFIX}${username.toLowerCase()}`);
    return stats || { wins: 0, losses: 0, draws: 0, gamesPlayed: 0 };
  } catch (e) {
    console.error('Erreur getUserStats:', e);
    return { wins: 0, losses: 0, draws: 0, gamesPlayed: 0 };
  }
}

async function updateUserStats(username, result) {
  if (!redis) return;
  try {
    const key = `${STATS_PREFIX}${username.toLowerCase()}`;
    await redis.hincrby(key, 'gamesPlayed', 1);
    if (result === 'win') await redis.hincrby(key, 'wins', 1);
    else if (result === 'loss') await redis.hincrby(key, 'losses', 1);
    else if (result === 'draw') await redis.hincrby(key, 'draws', 1);
  } catch (e) {
    console.error('Erreur updateUserStats:', e);
  }
}

async function saveDeck(username, deckName, deckData) {
  if (!redis) return;
  try {
    await redis.set(`${DECK_PREFIX}${username.toLowerCase()}:${deckName}`, JSON.stringify(deckData));
  } catch (e) {
    console.error('Erreur saveDeck:', e);
  }
}

async function getDecks(username) {
  if (!redis) return {};
  try {
    const keys = await redis.keys(`${DECK_PREFIX}${username.toLowerCase()}:*`);
    const decks = {};
    for (const key of keys) {
      const deckName = key.split(':').pop();
      const deck = await redis.get(key);
      if (deck) {
        decks[deckName] = typeof deck === 'string' ? JSON.parse(deck) : deck;
      }
    }
    return decks;
  } catch (e) {
    console.error('Erreur getDecks:', e);
    return {};
  }
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

// Health check - protégé contre les erreurs Redis
app.get('/', async (req, res) => {
  try {
    const keys = await redis.keys(`${ROOM_PREFIX}*`);
    res.json({ 
      status: 'OK', 
      rooms: keys.length,
      uptime: process.uptime()
    });
  } catch (e) {
    res.json({ 
      status: 'OK (Redis indisponible)', 
      rooms: 0,
      uptime: process.uptime()
    });
  }
});

// Liste des salles (debug)
app.get('/api/rooms', async (req, res) => {
  try {
    const keys = await redis.keys(`${ROOM_PREFIX}*`);
    const roomsList = [];
    for (const key of keys) {
      const room = await redis.get(key);
      if (room) {
        const roomData = typeof room === 'string' ? JSON.parse(room) : room;
        roomsList.push({
          id: roomData.id,
          players: roomData.players.length,
          createdAt: roomData.createdAt
        });
      }
    }
    res.json(roomsList);
  } catch (e) {
    console.error('Erreur rooms:', e);
    res.json([]);
  }
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/`);
});
