// server.js
const WebSocket = require('ws');
const https = require('https'); // Usar 'https' en lugar de 'http'
const fs = require('fs'); // Módulo para leer archivos
const Logger = require('../src/logger');
const TaskScheduler = require('../src/taskScheduler');
require('dotenv').config();

// --- Configuración de Seguridad ---
const ENABLE_ORIGIN_VALIDATION = process.env.ENABLE_ORIGIN_VALIDATION === 'true';
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [];
const MAX_CONNECTIONS_PER_IP = parseInt(process.env.MAX_CONNECTIONS_PER_IP) || 5;

// --- Cargar los Certificados SSL ---
const options = {
  key: fs.readFileSync(process.env.SSL_KEY_PATH),
  cert: fs.readFileSync(process.env.SSL_CERT_PATH)
};

// --- Estructuras de Datos ---
const clientConnections = new Map();
const clientsByIp = new Map();

// --- Creación del Servidor ---
const scheduler = new TaskScheduler();
const server = https.createServer(options, (req, res) => { // Usar 'https.createServer'
    // Manejador de Webhook
    if (req.method === 'POST' && req.url === '/webhook') {
        // ... (resto del código del webhook sin cambios) ...
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                const eventData = JSON.parse(body);
                scheduler.handleWebhook(eventData);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'success', message: 'Webhook recibido y procesado' }));
            } catch (error) {
                Logger.error('Error al procesar el Webhook. JSON inválido.', { error: error.message });
                res.writeHead(400);
                res.end('Error: Datos JSON no válidos.');
            }
        });
    } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Servidor WebSocket y Webhook activo.\n');
    }
});

const wsServer = new WebSocket.Server({ server }); // Pasar el servidor HTTPS al WebSocket.Server

// --- Manejo de Conexiones WebSocket ---
wsServer.on('connection', (ws, request) => {
    // ... (resto del código de manejo de conexiones sin cambios) ...
    const clientIp = request.socket.remoteAddress;

    const currentConnections = clientConnections.get(clientIp) || 0;
    clientConnections.set(clientIp, currentConnections + 1);

    if (!clientsByIp.has(clientIp)) {
        clientsByIp.set(clientIp, new Set());
    }
    clientsByIp.get(clientIp).add(ws);

    Logger.info(`Cliente conectado con éxito. Conexiones activas para ${clientIp}: ${currentConnections + 1}`);

    ws.on('message', async message => {
        scheduler.handleClientMessage(ws, message);
    });

    ws.on('close', () => {
        Logger.info('Cliente desconectado.', { ip: clientIp });

        const currentConnections = clientConnections.get(clientIp);
        if (currentConnections > 1) {
            clientConnections.set(clientIp, currentConnections - 1);
        } else {
            clientConnections.delete(clientIp);
        }

        const clients = clientsByIp.get(clientIp);
        if (clients) {
            clients.delete(ws);
            if (clients.size === 0) {
                clientsByIp.delete(clientIp);
            }
        }

        scheduler.cleanUp(ws);
        Logger.info(`Conexiones activas para ${clientIp}: ${clientConnections.get(clientIp) || 0}`);
    });

    ws.on('error', error => {
        Logger.error('Error en la conexión WebSocket.', { error: error.message });
    });
});

// Arrancar el servidor
const PORT = process.env.PORT || 8443;
server.listen(PORT, () => {
    Logger.info(`Servidor WebSocket seguro (WSS) escuchando en el puerto ${PORT}.`);
});