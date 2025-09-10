// src/TaskScheduler.js
const fs = require('fs').promises;
const path = require('path');
const https = require('https');
require('dotenv').config();

const TASKS_FILE = path.join(__dirname, 'tasks.json');

class TaskScheduler {
    constructor() {
        this.tasks = [];
        this.loadTasks();
        this.runningStreams = new Map(); // Para gestionar las tareas continuas
    }

    async loadTasks() {
        try {
            const data = await fs.readFile(TASKS_FILE, 'utf8');
            this.tasks = JSON.parse(data);
            console.log(`✅ Tareas cargadas: ${this.tasks.length}`);
        } catch (error) {
            console.error('⚠️ Archivo de tareas no encontrado o con error. Iniciando con una lista vacía.');
            this.tasks = [];
        }
    }

    async saveTasks() {
        try {
            const data = JSON.stringify(this.tasks, null, 2);
            await fs.writeFile(TASKS_FILE, data, 'utf8');
            console.log('📁 Tareas guardadas en el archivo.');
        } catch (error) {
            console.error('❌ Error al guardar las tareas:', error.message);
        }
    }

    async handleTask(taskData, ws) {
        const { url_api_destino, metodo_peticion, continuo, interval } = taskData;
        const taskId = `${url_api_destino}-${metodo_peticion}`;

        if (continuo) {
            if (this.runningStreams.has(taskId)) {
                return { status: 'info', message: 'El stream para esta tarea ya está activo.' };
            }
            const result = await this._startContinuousTask(taskData, ws);
            return result;
        } else {
            const result = await this._executeAndSaveTask(taskData);
            return result;
        }
    }

    async _executeAndSaveTask(taskData) {
        const taskId = `${taskData.url_api_destino}-${taskData.metodo_peticion}-${Date.now()}`;
        
        const newTask = {};
        newTask.id = taskId;
        newTask.fecha_creacion = new Date().toISOString();
        newTask.url_api_destino = taskData.url_api_destino;
        newTask.metodo_peticion = taskData.metodo_peticion;
        newTask.body_peticion = taskData.body_peticion || null;
        newTask.estado = 'pendiente';

        this.tasks.push(newTask);

        try {
            const apiResponse = await this._makeApiRequest(newTask);
            newTask.estado = 'completada';
            newTask.ultima_respuesta = apiResponse;
            await this.saveTasks();
            return { status: 'success', message: 'Tarea ejecutada y completada.', task: newTask };
        } catch (error) {
            newTask.estado = 'error';
            newTask.ultima_respuesta = { error: error.message };
            await this.saveTasks();
            return { status: 'error', message: 'Error al ejecutar la tarea.', task: newTask };
        }
    }

    async _startContinuousTask(taskData, ws) {
        const taskId = `${taskData.url_api_destino}-${taskData.metodo_peticion}`;
        const { url_api_destino, metodo_peticion, body_peticion, interval } = taskData;

        const stream = {
            ws: ws,
            intervalId: null
        };

        const execute = async () => {
            try {
                const apiResponse = await this._makeApiRequest(taskData);
                if (stream.ws.readyState === WebSocket.OPEN) {
                    stream.ws.send(JSON.stringify({ status: 'update', data: apiResponse }));
                }
            } catch (error) {
                if (stream.ws.readyState === WebSocket.OPEN) {
                    stream.ws.send(JSON.stringify({ status: 'error', message: `Error en stream: ${error.message}` }));
                }
            }
        };

        stream.intervalId = setInterval(execute, interval);
        this.runningStreams.set(taskId, stream);
        
        return { status: 'stream_started', taskId: taskId, message: `Iniciando stream a ${url_api_destino} cada ${interval}ms.` };
    }

    stopTask(taskId) {
        if (this.runningStreams.has(taskId)) {
            const stream = this.runningStreams.get(taskId);
            clearInterval(stream.intervalId);
            this.runningStreams.delete(taskId);
            console.log(`Stream ${taskId} detenido y eliminado.`);
            return { status: 'stream_stopped', message: `Stream ${taskId} detenido.` };
        }
        return { status: 'stream_not_found', message: 'No hay stream activo para detener.' };
    }

    _makeApiRequest(task) {
        return new Promise((resolve, reject) => {
            const { url_api_destino, metodo_peticion, body_peticion } = task;
            const options = {
                method: metodo_peticion,
                headers: { 'Content-Type': 'application/json' }
            };
            const req = https.request(url_api_destino, options, res => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    try {
                        const responseData = data ? JSON.parse(data) : null;
                        resolve(responseData);
                    } catch (error) {
                        reject(new Error(`Error al analizar la respuesta JSON: ${error.message}`));
                    }
                });
            });
            req.on('error', err => reject(new Error(`Error en la petición a la API: ${err.message}`)));
            if (body_peticion) { req.write(JSON.stringify(body_peticion)); }
            req.end();
        });
    }
}

module.exports = TaskScheduler;