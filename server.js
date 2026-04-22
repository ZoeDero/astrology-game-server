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

// Servir les fichiers statiques du build React
app.use(express.static('build'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: false
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 30000,
  pingInterval: 10000
});

// Fallback mémoire si Redis ne fonctionne pas
const memoryStore = new Map();
let useMemoryFallback = false;

// Redis client pour stocker les salles (persistance)
let redis;
try {
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  console.log('Redis initialisé avec succès');
} catch (e) {
  console.error('Erreur initialisation Redis:', e);
  useMemoryFallback = true;
}

const ROOM_PREFIX = 'room:';
const ROOM_TTL = 60 * 60; // 1 heure
const USER_PREFIX = 'user:';
const DECK_PREFIX = 'deck:';
const STATS_PREFIX = 'stats:';

// Fonctions helper pour Redis - Salles avec fallback mémoire
async function getRoom(roomId) {
  try {
    if (useMemoryFallback) {
      return memoryStore.get(roomId.toUpperCase()) || null;
    }
    const room = await redis.get(`${ROOM_PREFIX}${roomId.toUpperCase()}`);
    if (!room) return null;
    if (typeof room === 'object') return room;
    return JSON.parse(room);
  } catch (e) {
    console.error('Erreur getRoom, fallback mémoire:', e);
    useMemoryFallback = true;
    return memoryStore.get(roomId.toUpperCase()) || null;
  }
}

async function setRoom(roomId, room) {
  try {
    if (useMemoryFallback) {
      memoryStore.set(roomId.toUpperCase(), room);
      return;
    }
    await redis.set(`${ROOM_PREFIX}${roomId.toUpperCase()}`, JSON.stringify(room), { ex: ROOM_TTL });
  } catch (e) {
    console.error('Erreur setRoom, fallback mémoire:', e);
    useMemoryFallback = true;
    memoryStore.set(roomId.toUpperCase(), room);
  }
}

async function deleteRoom(roomId) {
  try {
    if (useMemoryFallback) {
      memoryStore.delete(roomId.toUpperCase());
      return;
    }
    await redis.del(`${ROOM_PREFIX}${roomId.toUpperCase()}`);
  } catch (e) {
    console.error('Erreur deleteRoom:', e);
  }
}

// Fonctions helper pour Redis - Utilisateurs
async function getUser(username) {
  console.log(`[GETUSER] Recherche de l'utilisateur: ${username}`);
  console.log(`[GETUSER] Mode mémoire: ${useMemoryFallback}`);
  console.log(`[GETUSER] Redis disponible:`, !!redis);
  
  if (!redis) {
    console.log(`[GETUSER] Redis non disponible, utilisation du fallback mémoire`);
    const user = memoryStore.get(username.toLowerCase()) || null;
    console.log(`[GETUSER] Résultat fallback mémoire:`, user);
    return user;
  }
  
  try {
    const user = await redis.hgetall(`${USER_PREFIX}${username.toLowerCase()}`);
    console.log(`[GETUSER] Données brutes Redis:`, user);
    
    if (!user || user === null || user === undefined) {
      console.log(`[GETUSER] Utilisateur non trouvé (null/undefined)`);
      return null;
    }
    
    if (typeof user !== 'object') {
      console.log(`[GETUSER] Utilisateur pas un objet (type: ${typeof user})`);
      return null;
    }
    
    const keys = Object.keys(user);
    console.log(`[GETUSER] Keys trouvées:`, keys);
    console.log(`[GETUSER] Keys length:`, keys.length);
    
    const result = keys.length > 0 ? user : null;
    console.log(`[GETUSER] Résultat final:`, result);
    return result;
  } catch (e) {
    console.error('Erreur getUser:', e);
    return null;
  }
}

async function createUser(username, passwordHash) {
  console.log(`[CREATEUSER] Création de l'utilisateur: ${username}`);
  
  if (!redis) {
    console.log(`[CREATEUSER] Redis non disponible, création annulée`);
    return;
  }
  
  try {
    console.log(`[CREATEUSER] Sauvegarde des données utilisateur...`);
    await redis.hset(`${USER_PREFIX}${username.toLowerCase()}`, {
      username: username,
      password: passwordHash,
      createdAt: Date.now()
    });
    
    console.log(`[CREATEUSER] Sauvegarde des stats...`);
    await redis.hset(`${STATS_PREFIX}${username.toLowerCase()}`, {
      wins: 0,
      losses: 0,
      draws: 0,
      gamesPlayed: 0
    });
    
    console.log(`[CREATEUSER] Utilisateur ${username} créé avec succès`);
    
    // Vérifier immédiatement que l'utilisateur a bien été créé
    const verification = await redis.hgetall(`${USER_PREFIX}${username.toLowerCase()}`);
    console.log(`[CREATEUSER] Vérification après création:`, verification);
    
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
  
  console.log(`[REGISTER] Tentative d'inscription pour: ${username}`);
  
  if (!username || !password) {
    console.log(`[REGISTER] Erreur: username ou password manquant`);
    return res.status(400).json({ error: 'Username et password requis' });
  }
  
  // Vérifier si l'utilisateur existe déjà
  console.log(`[REGISTER] Vérification si l'utilisateur ${username} existe déjà...`);
  const existingUser = await getUser(username);
  console.log(`[REGISTER] Utilisateur existant trouvé:`, !!existingUser);
  
  if (existingUser) {
    console.log(`[REGISTER] Erreur: l'utilisateur ${username} existe déjà`);
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
    console.log(`[CREATE] Tentative createRoom par ${socket.id} (${playerName})`);
    try {
      const roomId = uuidv4().substr(0, 8).toUpperCase();
      console.log(`[CREATE] RoomID généré: ${roomId}`);
      
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
      
      console.log(`[CREATE] Appel setRoom...`);
      await setRoom(roomId, room);
      console.log(`[CREATE] setRoom réussi`);
      
      socket.join(roomId);
      console.log(`[CREATE] socket.join réussi`);
      
      socket.emit('roomCreated', { roomId, isHost: true, playerName: playerName || 'Joueur 1', players: room.players });
      console.log(`[CREATE] roomCreated émis`);
    } catch (err) {
      console.error(`[CREATE] ERREUR:`, err);
      socket.emit('error', { message: 'Erreur création salle' });
    }
  });

  // Rejoindre une salle
  socket.on('joinRoom', async ({ roomId, playerName }) => {
    console.log(`[JOIN] ===== TENTATIVE DE JOIN =====`);
    console.log(`[JOIN] RoomID: ${roomId}`);
    console.log(`[JOIN] SocketID: ${socket.id}`);
    console.log(`[JOIN] PlayerName: ${playerName}`);
    console.log(`[JOIN] Mode mémoire: ${useMemoryFallback}`);
    
    const room = await getRoom(roomId);
    console.log(`[JOIN] Room trouvée:`, room);
    
    if (!room) {
      console.log(`[JOIN] Room ${roomId} non trouvée!`);
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
      name: playerName
    });
    
    // Sauvegarder la salle mise à jour
    await setRoom(roomId, room);
    
    const joiningPlayer = room.players.find(p => p.id === socket.id);
    
    socket.join(roomId);
    socket.emit('roomJoined', { 
      roomId, 
      isHost: false, 
      playerName: joiningPlayer?.name,
      opponentName: room.players[0]?.name
    });
    
    // Notifier tout le monde dans la room (y compris l'hôte)
    io.to(roomId).emit('playerJoined', {
      playerId: socket.id,
      playerName: joiningPlayer?.name || 'Joueur 2',
      players: room.players
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

  // Test de communication
  socket.on('test', (data) => {
    console.log(`[TEST] Reçu:`, data);
    socket.emit('testResponse', { received: true, message: 'Serveur a bien reçu' });
  });

  // Démarrer la partie (manquant)
  socket.on('startGame', async ({ roomId }) => {
    console.log(`[START] ===== DEMANDE DE DEMARRAGE =====`);
    console.log(`[START] RoomID: ${roomId}`);
    console.log(`[START] SocketID: ${socket.id}`);
    console.log(`[START] Timestamp: ${new Date().toISOString()}`);
    
    try {
      const room = await getRoom(roomId);
      if (!room) {
        console.log(`[START] Erreur: salle ${roomId} non trouvée`);
        socket.emit('gameStartError', 'Salle non trouvée');
        return;
      }
      
      if (room.players.length !== 2) {
        console.log(`[START] Erreur: salle ${roomId} n'a pas 2 joueurs (${room.players.length})`);
        socket.emit('gameStartError', 'La salle doit contenir 2 joueurs');
        return;
      }
      
      // Vérifier que l'hôte démarre la partie
      const hostPlayer = room.players.find(p => p.isHost);
      if (!hostPlayer || hostPlayer.id !== socket.id) {
        console.log(`[START] Erreur: seul l'hôte peut démarrer la partie`);
        console.log(`[START] HostPlayer:`, hostPlayer);
        console.log(`[START] SocketID: ${socket.id}`);
        socket.emit('gameStartError', 'Seul l\'hôte peut démarrer la partie');
        return;
      }
      
      console.log(`[START] Initialisation de la partie pour la salle ${roomId}`);
      
      // Créer l'état de jeu initial pour multijoueur
      const initialGameState = {
        phase: 'playing',
        currentPlayer: room.players[0].id, // L'hôte commence
        turn: 1,
        players: {
          [room.players[0].id]: {
            life: 20,
            mana: 1,
            maxMana: 1,
            hand: [], // Sera rempli plus tard
            deck: [], // Sera rempli plus tard
            lands: [],
            field: [],
            graveyard: [],
            attackedCreatures: []
          },
          [room.players[1].id]: {
            life: 20,
            mana: 1,
            maxMana: 1,
            hand: [], // Sera rempli plus tard
            deck: [], // Sera rempli plus tard
            lands: [],
            field: [],
            graveyard: [],
            attackedCreatures: []
          }
        }
      };
      
      // Initialiser les decks et les mains pour les deux joueurs
      console.log(`[START] Initialisation des decks et mains`);
      
      // Pour chaque joueur, créer un deck de base et piocher 5 cartes
      for (let i = 0; i < room.players.length; i++) {
        const player = room.players[i];
        const playerSocketId = player.id;
        
        // Créer un deck de base (30 cartes)
        const basicDeck = [
          { id: 'basic_land_1', name: 'Terrain de base', type: 'land', cost: 0 },
          { id: 'basic_land_2', name: 'Terrain de base', type: 'land', cost: 0 },
          { id: 'basic_land_3', name: 'Terrain de base', type: 'land', cost: 0 },
          { id: 'basic_land_4', name: 'Terrain de base', type: 'land', cost: 0 },
          { id: 'basic_land_5', name: 'Terrain de base', type: 'land', cost: 0 },
          { id: 'basic_creature_1', name: 'Créature de base', type: 'creature', cost: 1, attack: 2, defense: 1 },
          { id: 'basic_creature_2', name: 'Créature de base', type: 'creature', cost: 2, attack: 3, defense: 2 },
          { id: 'basic_creature_3', name: 'Créature de base', type: 'creature', cost: 1, attack: 1, defense: 3 },
          { id: 'basic_creature_4', name: 'Créature de base', type: 'creature', cost: 2, attack: 2, defense: 2 },
          { id: 'basic_creature_5', name: 'Créature de base', type: 'creature', cost: 3, attack: 4, defense: 3 }
        ];
        
        // Compléter le deck pour avoir 30 cartes
        const fullDeck = [];
        for (let j = 0; j < 6; j++) {
          fullDeck.push(...basicDeck);
        }
        
        // Mélanger le deck
        const shuffledDeck = fullDeck.sort(() => Math.random() - 0.5);
        
        // Piocher 5 cartes pour la main
        const hand = shuffledDeck.slice(0, 5);
        const remainingDeck = shuffledDeck.slice(5);
        
        initialGameState.players[playerSocketId].deck = remainingDeck;
        initialGameState.players[playerSocketId].hand = hand;
        
        console.log(`[START] Joueur ${player.name} - Main: ${hand.length} cartes, Deck: ${remainingDeck.length} cartes`);
      }
      
      room.gameState = initialGameState;
      await setRoom(roomId, room);
      
      console.log(`[START] Émission gameStarted vers la salle ${roomId}`);
      console.log(`[START] GameState:`, initialGameState);
      
      // Notifier tous les joueurs avec le même événement
      console.log(`[START] Envoi gameStarted à ${room.players.length} joueurs`);
      io.to(roomId).emit('gameStarted', {
        gameState: initialGameState,
        opponentId: room.players[1].id // Pour l'hôte, l'adversaire est le joueur 2
      });
      console.log(`[START] gameStarted émis avec succès`);
      
      // Confirmer à l'émetteur
      socket.emit('startGameReceived', { success: true, roomId });
      console.log(`[START] startGameReceived envoyé à l'émetteur`);
      
    } catch (error) {
      console.error(`[START] Erreur lors du démarrage:`, error);
      socket.emit('gameStartError', 'Erreur lors du démarrage de la partie');
    }
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
    
    // Chercher et retirer le joueur de toutes les salles
    try {
      const keys = await redis.keys(`${ROOM_PREFIX}*`);
      for (const key of keys) {
        const room = await redis.get(key);
        if (room) {
          const roomData = typeof room === 'string' ? JSON.parse(room) : room;
          const playerIndex = roomData.players.findIndex(p => p.id === socket.id);
          if (playerIndex !== -1) {
            roomData.players.splice(playerIndex, 1);
            await setRoom(roomData.id, roomData);
            socket.to(roomData.id).emit('playerDisconnected', { playerId: socket.id });
            console.log(`Joueur ${socket.id} retiré de la salle ${roomData.id}`);
          }
        }
      }
    } catch (e) {
      console.error('Erreur lors de la déconnexion:', e);
    }
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
