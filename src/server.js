// server.js
const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path'); // Importa el módulo 'path'
const Logger = require('../src/logger');
const TaskScheduler = require('../src/taskScheduler');
require('dotenv').config();

// --- Configuración de Seguridad ---
const ENABLE_ORIGIN_VALIDATION = process.env.ENABLE_ORIGIN_VALIDATION === 'true';
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [];
const MAX_CONNECTIONS_PER_IP = parseInt(process.env.MAX_CONNECTIONS_PER_IP) || 5;

// --- Cargar los Certificados SSL de forma segura ---
try {
    const options = {
      key: fs.readFileSync(path.resolve(process.env.SSL_KEY_PATH)),
      cert: fs.readFileSync(path.resolve(process.env.SSL_CERT_PATH))
    };

    // --- Creación del Servidor HTTPS ---
    const scheduler = new TaskScheduler();
    const server = https.createServer(options, (req, res) => {
        if (req.method === 'POST' && req.url === '/webhook') {
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

    const wsServer = new WebSocket.Server({ server });

    // --- Manejo de Conexiones WebSocket ---
    wsServer.on('connection', (ws, request) => {
        // Tu código de manejo de conexiones aquí...
    });

    const PORT = process.env.PORT || 8443;
    server.listen(PORT, () => {
        Logger.info(`Servidor WebSocket seguro (WSS) escuchando en el puerto ${PORT}.`);
    });

} catch (error) {
    Logger.error('Error al cargar los archivos de certificado SSL. Revisa las rutas en .env.', { error: error.message, sslKeyPath: process.env.SSL_KEY_PATH, sslCertPath: process.env.SSL_CERT_PATH });
    process.exit(1); // Sale del proceso con un error
}