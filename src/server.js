// server.js
const WebSocket = require('ws');
const http = require('http');
const url = require('url');
const TaskScheduler = require('../src/taskScheduler');
require('dotenv').config();

// --- Configuración de Seguridad ---
// Ahora la validación se activa si el valor de la variable es 'on' (en minúsculas).
const ENABLE_ORIGIN_VALIDATION = process.env.ENABLE_ORIGIN_VALIDATION === 'on';
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [];
const ALLOWED_APIS = process.env.ALLOWED_APIS ? process.env.ALLOWED_APIS.split(',') : [];

// --- Estructuras de Datos ---
const clientTasks = new Map();

// --- Creación del Servidor ---
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Servidor WebSocket activo\n');
});

// --- Validación de Origen Integrada ---
const wsServer = new WebSocket.Server({
    server: server,
    verifyClient: (info, done) => {
        const origin = info.origin;
        console.log(`📡 Solicitud de conexión recibida desde: ${origin || 'Origen no especificado'}`);

        if (ENABLE_ORIGIN_VALIDATION) {
            if (ALLOWED_ORIGINS.includes(origin)) {
                console.log(`✅ Conexión aceptada para el origen: ${origin}`);
                return done(true);
            } else {
                console.log(`🚫 Conexión rechazada: El origen "${origin || 'no especificado'}" no está en la lista de permitidos.`);
                return done(false, 401, 'Unauthorized Origin');
            }    
        }else
        {
            return done(true); // Validación desactivada, permitir la conexión.
        }

        
    }
});

const scheduler = new TaskScheduler();

// --- Manejo de Conexiones WebSocket ---
wsServer.on('connection', ws => {
    console.log('✅ Cliente conectado con éxito.');

    ws.on('message', async message => {
        try {
            const data = JSON.parse(message);
            console.log('📬 Mensaje recibido:', data);

            // Regla de seguridad: Validación de API
            const destinationUrl = url.parse(data.url_api_destino);
            const destinationOrigin = `${destinationUrl.protocol}//${destinationUrl.host}`;

            if (ENABLE_ORIGIN_VALIDATION && !ALLOWED_APIS.includes(destinationOrigin)) {
                console.log(`❌ Petición rechazada: La API "${destinationOrigin}" no está permitida.`);
                ws.send(JSON.stringify({
                    status: 'error',
                    message: `La API ${destinationOrigin} no está en la lista de APIs permitidas.`
                }));
                return;
            }

            const task = await scheduler.handleTask(data, ws);
            
            if (task.status === 'stream_started') {
                clientTasks.set(ws, task.taskId);
                console.log(`🟢 Stream iniciado para la tarea: ${task.taskId}`);
            } else if (task.status === 'stream_stopped') {
                clientTasks.delete(ws);
                console.log(`⚫ Stream detenido para la tarea: ${task.taskId}`);
            }

            ws.send(JSON.stringify(task));

        } catch (error) {
            console.error('❌ Error al procesar el mensaje:', error.message);
            ws.send(JSON.stringify({ 
                status: 'error', 
                message: 'Error en la petición o en el formato JSON.'
            }));
        }
    });

    ws.on('close', () => {
        console.log('🔌 Cliente desconectado.');
        if (clientTasks.has(ws)) {
            const taskId = clientTasks.get(ws);
            scheduler.stopTask(taskId);
            clientTasks.delete(ws);
            console.log(`🔴 Tarea ${taskId} detenida y eliminada por desconexión del cliente.`);
        }
    });

    ws.on('error', error => {
        console.error('⚠️ Error en la conexión WebSocket:', error);
    });
});

const PORT = process.env.PORT || 8443;
server.listen(PORT, () => {
    console.log(`🚀 Servidor WebSocket escuchando en el puerto ${PORT}.`);
});