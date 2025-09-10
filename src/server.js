// server.js
const WebSocket = require('ws');
const TaskScheduler = require('./src/taskScheduler');
const http = require('http');

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Servidor WebSocket activo\n');
});

const wsServer = new WebSocket.Server({ server });

// Creamos una instancia única de nuestro planificador de tareas
const scheduler = new TaskScheduler();
scheduler.startScheduler(); // Iniciamos el planificador

wsServer.on('connection', ws => {
    console.log('Cliente conectado');

    ws.on('message', message => {
        try {
            // Analizamos el mensaje como JSON
            const data = JSON.parse(message);
            console.log('Mensaje recibido:', data);

            // Pasamos la tarea directamente al planificador
            scheduler.addTask(data, ws);

        } catch (error) {
            console.error('Error al analizar el mensaje JSON:', error.message);
            ws.send(JSON.stringify({ error: 'Formato de mensaje JSON inválido.' }));
        }
    });

    ws.on('close', () => {
        console.log('Cliente desconectado');
    });

    ws.on('error', error => {
        console.error('Error en la conexión WebSocket:', error);
    });
});

const PORT = process.env.PORT || 8443;
server.listen(PORT, () => {
    console.log(`Servidor WebSocket escuchando en el puerto ${PORT}`);
});