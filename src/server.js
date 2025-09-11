// server.js
const WebSocket = require('ws'); // Módulo principal para el servidor WebSocket
const http = require('http');     // Módulo para crear el servidor HTTP base
const url = require('url');       // Módulo para parsear y analizar URLs
const TaskScheduler = require('./src/TaskScheduler'); // Importamos la clase TaskScheduler
require('dotenv').config();       // Carga las variables de entorno del archivo .env

// --- Configuración de Seguridad ---
// Estas variables controlan las reglas de validación del servidor.
const ENABLE_ORIGIN_VALIDATION = process.env.ENABLE_ORIGIN_VALIDATION === 'true';
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [];
const ALLOWED_APIS = process.env.ALLOWED_APIS ? process.env.ALLOWED_APIS.split(',') : [];

// --- Estructuras de Datos ---
// 'clientTasks' asocia cada conexión de WebSocket con su tarea activa.
// Esto es vital para detener un stream si el cliente se desconecta.
const clientTasks = new Map();

// --- Creación del Servidor ---
// Creamos un servidor HTTP básico.
// Este servidor no hace nada más que escuchar peticiones.
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Servidor WebSocket activo\n');
});

// Vinculamos el servidor WebSocket al servidor HTTP.
const wsServer = new WebSocket.Server({ server });
const scheduler = new TaskScheduler(); // Creamos una instancia del TaskScheduler

// --- Manejo de Conexiones WebSocket ---
// 'on connection' se ejecuta cada vez que un cliente se conecta.
wsServer.on('connection', ws => {
    console.log('Cliente conectado');

    // 'on message' se ejecuta cada vez que el servidor recibe un mensaje.
    // Aquí es donde se valida y procesa cada petición.
    ws.on('message', async message => {
        try {
            const data = JSON.parse(message);
            console.log('Mensaje recibido:', data);

            // --- Regla de Seguridad: Validación de API ---
            // Analizamos la URL de la petición para extraer el dominio.
            const destinationUrl = url.parse(data.url_api_destino);
            const destinationOrigin = `${destinationUrl.protocol}//${destinationUrl.host}`;

            // Si la validación está activa y el dominio de la API no está permitido,
            // enviamos un error y no procesamos la tarea.
            if (ENABLE_ORIGIN_VALIDATION && !ALLOWED_APIS.includes(destinationOrigin)) {
                ws.send(JSON.stringify({
                    status: 'error',
                    message: `La API ${destinationOrigin} no está en la lista de APIs permitidas.`
                }));
                return; // Detenemos el flujo de código para esta petición.
            }

            // Delegamos la tarea al TaskScheduler para que la gestione.
            const task = await scheduler.handleTask(data, ws);
            
            // Si el TaskScheduler inicia un stream, guardamos la referencia
            // para poder detenerlo si es necesario.
            if (task.status === 'stream_started') {
                clientTasks.set(ws, task.taskId);
            } else if (task.status === 'stream_stopped') {
                clientTasks.delete(ws);
            }

            // Enviamos la respuesta del scheduler al cliente.
            ws.send(JSON.stringify(task));

        } catch (error) {
            console.error('Error:', error.message);
            ws.send(JSON.stringify({ 
                status: 'error', 
                message: 'Error en la petición o en el formato JSON.'
            }));
        }
    });

    // 'on close' se ejecuta cuando un cliente se desconecta.
    ws.on('close', () => {
        console.log('Cliente desconectado');
        // Si el cliente tenía una tarea continua activa, la detenemos
        // para evitar que se ejecute indefinidamente (tarea "zombie").
        if (clientTasks.has(ws)) {
            const taskId = clientTasks.get(ws);
            scheduler.stopTask(taskId);
            clientTasks.delete(ws);
            console.log(`Tarea ${taskId} detenida y eliminada por desconexión del cliente.`);
        }
    });

    // 'on error' maneja cualquier error de la conexión WebSocket.
    ws.on('error', error => {
        console.error('Error en la conexión WebSocket:', error);
    });
});

// --- Inicio del Servidor ---
// El servidor comienza a escuchar en el puerto especificado en el archivo .env.
const PORT = process.env.PORT || 8443;
server.listen(PORT, () => {
    console.log(`Servidor WebSocket escuchando en el puerto ${PORT}`);
});