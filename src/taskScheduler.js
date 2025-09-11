// src/TaskScheduler.js
const fs = require('fs').promises;
const path = require('path');
const https = require('https');
require('dotenv').config();
const WebSocket = require('ws'); // <-- This is the new, critical line

const TASKS_FILE = path.join(__dirname, 'tasks.json');

/**
 * TaskScheduler
 *
 * El cerebro de la aplicación. Se encarga de gestionar todas las tareas,
 * ya sean de ejecución única o de flujos de datos continuos.
 * Mantiene un registro de las tareas para asegurar que no haya duplicados
 * y para manejar su estado de forma correcta.
 */
class TaskScheduler {
    constructor() {
        // 'tasks' guarda un historial de todas las tareas (ejecutadas o no)
        this.tasks = [];
        this.loadTasks();

        // 'runningStreams' solo guarda las tareas continuas que están activas.
        // Usa un 'Map' para un acceso rápido y eficiente.
        this.runningStreams = new Map();
    }

    // --- Métodos de Gestión de Archivos ---

    /**
     * Carga el historial de tareas desde el archivo 'tasks.json'.
     * Si el archivo no existe o hay un error, inicializa una lista vacía.
     */
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

    /**
     * Guarda el estado actual de las tareas en el archivo 'tasks.json'.
     * Esto asegura que el historial persista incluso si el servidor se reinicia.
     */
    async saveTasks() {
        try {
            const data = JSON.stringify(this.tasks, null, 2);
            await fs.writeFile(TASKS_FILE, data, 'utf8');
            console.log('📁 Tareas guardadas en el archivo.');
        } catch (error) {
            console.error('❌ Error al guardar las tareas:', error.message);
        }
    }

    // --- Lógica Principal de Tareas ---

    /**
     * Punto de entrada para todas las peticiones del cliente.
     * Decide si una tarea es de una sola ejecución o un flujo de datos continuo.
     * @param {object} taskData - Datos de la tarea enviados por el cliente.
     * @param {object} ws - La instancia del WebSocket del cliente.
     */
    async handleTask(taskData, ws) {
        const { url_api_destino, metodo_peticion, continuo } = taskData;
        const taskId = `${url_api_destino}-${metodo_peticion}`;

        if (continuo) {
            // Si la tarea es continua, revisamos si ya hay un stream activo
            if (this.runningStreams.has(taskId)) {
                return { status: 'info', message: 'El stream para esta tarea ya está activo.' };
            }
            // Si no existe, iniciamos uno nuevo
            return await this._startContinuousTask(taskData, ws);
        } else {
            // Si la tarea es de una sola ejecución, la procesamos inmediatamente
            return await this._executeAndSaveTask(taskData);
        }
    }

    // --- Métodos Internos de Ejecución ---

    /**
     * Procesa una tarea de ejecución única.
     * - Crea un ID único basado en el tiempo.
     * - Realiza la petición a la API.
     * - Actualiza el estado de la tarea (completada o con error).
     * - Guarda el historial completo de tareas en el archivo.
     * @param {object} taskData - Datos de la tarea.
     */
    async _executeAndSaveTask(taskData) {
        const taskId = `${taskData.url_api_destino}-${taskData.metodo_peticion}-${Date.now()}`;
        
        const newTask = {
            id: taskId,
            fecha_creacion: new Date().toISOString(),
            url_api_destino: taskData.url_api_destino,
            metodo_peticion: taskData.metodo_peticion,
            body_peticion: taskData.body_peticion || null,
            estado: 'pendiente'
        };

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

    /**
     * Inicia un flujo de datos continuo.
     * - Crea un 'setInterval' para ejecutar la petición repetidamente.
     * - Almacena el ID del intervalo y la conexión del cliente para su gestión.
     * @param {object} taskData - Datos de la tarea.
     * @param {object} ws - La instancia del WebSocket del cliente.
     */
    async _startContinuousTask(taskData, ws) {
        const { url_api_destino, metodo_peticion, interval } = taskData;
        const taskId = `${url_api_destino}-${metodo_peticion}`;

        // La función que se ejecutará en cada intervalo
        // La conexión 'ws' es ahora un argumento de la función anidada
        const execute = async (clientWs) => {
            try {
                // Realiza la petición de forma asíncrona y espera el resultado
                const apiResponse = await this._makeApiRequest(taskData);
                
                // Usamos el 'clientWs' que fue pasado de forma explícita
                if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({ status: 'update', data: apiResponse }));
                }
            } catch (error) {
                // Si hay un error, lo envía al cliente y lo registra
                if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({ status: 'error', message: `Error en stream: ${error.message}` }));
                }
            }
        };

        // Inicia el intervalo y pasa el objeto 'ws' como argumento para la función 'execute'
        const intervalId = setInterval(() => execute(ws), interval);
        // Asociamos el ID del stream con el WebSocket del cliente
        this.runningStreams.set(taskId, { intervalId, ws });
        
        return { status: 'stream_started', taskId: taskId, message: `Iniciando stream a ${url_api_destino} cada ${interval}ms.` };
    }

    /**
     * Detiene una tarea de flujo de datos continua.
     * - Es llamada por 'server.js' cuando el cliente se desconecta o solicita detener el stream.
     * - Limpia el 'setInterval' para evitar que el bucle se ejecute indefinidamente.
     * - Elimina la tarea de la lista de streams activos.
     * @param {string} taskId - El ID del stream a detener.
     */
    stopTask(taskId) {
        if (this.runningStreams.has(taskId)) {
            const { intervalId } = this.runningStreams.get(taskId);
            clearInterval(intervalId); // Detiene el bucle
            this.runningStreams.delete(taskId); // Elimina la referencia
            console.log(`Stream ${taskId} detenido y eliminado.`);
            return { status: 'stream_stopped', message: `Stream ${taskId} detenido.` };
        }
        return { status: 'stream_not_found', message: 'No hay stream activo para detener.' };
    }

    // --- Utilidades ---

    /**
     * Realiza una petición HTTPS a la API de destino.
     * - Retorna una Promesa para poder ser usada con 'async/await'.
     * @param {object} task - El objeto de la tarea con los datos de la petición.
     */
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