// server.js
const WebSocket = require('ws');
const http = require('http');
const TaskScheduler = require('../src/taskScheduler');

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Servidor WebSocket activo\n');
});

const wsServer = new WebSocket.Server({ server });

const scheduler = new TaskScheduler();
// Un mapa para rastrear qué cliente está ejecutando qué tarea
const clientTasks = new Map(); 

wsServer.on('connection', ws => {
    console.log('Cliente conectado');

    ws.on('message', async message => {
        try {
            const data = JSON.parse(message);
            console.log('Mensaje recibido:', data);

            // Pasamos la tarea al scheduler para que la gestione
            const task = await scheduler.handleTask(data, ws);
            
            // Si la tarea se inició, la registramos con la conexión del cliente
            if (task.status === 'stream_started') {
                clientTasks.set(ws, task.taskId);
            } else if (task.status === 'stream_stopped') {
                clientTasks.delete(ws);
            }

            ws.send(JSON.stringify(task));

        } catch (error) {
            console.error('Error:', error.message);
            ws.send(JSON.stringify({ 
                status: 'error', 
                message: 'Error en la petición o en el formato JSON.'
            }));
        }
    });

    ws.on('close', () => {
        console.log('Cliente desconectado');
        // Regla 1: Si un cliente desconecta, eliminamos su tarea 'running'
        if (clientTasks.has(ws)) {
            const taskId = clientTasks.get(ws);
            scheduler.stopTask(taskId);
            clientTasks.delete(ws);
            console.log(`Tarea ${taskId} detenida y eliminada por desconexión del cliente.`);
        }
    });

    ws.on('error', error => {
        console.error('Error en la conexión WebSocket:', error);
    });
});

const PORT = process.env.PORT || 8443;
server.listen(PORT, () => {
    console.log(`Servidor WebSocket escuchando en el puerto ${PORT}`);
});