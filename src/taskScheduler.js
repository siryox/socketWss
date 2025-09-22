// src/TaskScheduler.js
const Logger = require('../src/logger');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const TASKS_FILE = path.resolve(__dirname, 'tasks.json');
const POLL_INTERVAL = 5000; // Sondeo cada 5 segundos
const API_TIMEOUT = 5000; // 5 segundos de timeout para la API

class TaskScheduler {
    constructor() {
        this.tasks = new Map();
        this.clientToTaskMap = new Map();
        this.clientSubscriptions = new Map();
        this.init();
    }

    init() {
        this.loadTasksFromFile();
        setInterval(() => this.pollAndSendTasks(), POLL_INTERVAL);
        Logger.info('TaskScheduler inicializado y proceso de sondeo activado.');
    }

    loadTasksFromFile() {
        try {
            if (fs.existsSync(TASKS_FILE)) {
                const tasksArray = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
                tasksArray.forEach(task => {
                    this.tasks.set(task.client, task);
                });
                Logger.info(`✅ Se cargaron ${this.tasks.size} tareas desde tasks.json.`);
            } else {
                Logger.info('tasks.json no encontrado. Se iniciará un nuevo archivo.');
                this.saveTask();
            }
        } catch (error) {
            Logger.error('❌ Error al cargar las tareas desde tasks.json.', { error: error.message });
        }
    }

    async handleClientMessage(ws, message) {
        try {
            const data = JSON.parse(message);
            const { service, token, api_url, operation } = data;
            const client_id = this.getClientId(ws);

            Logger.info(`📩 Mensaje recibido de ${client_id}. Operación: ${operation}.`);

            if (operation === 'subscribe') {
                if (!client_id) {
                    this.sendErrorToClient(ws, 'No se pudo identificar al cliente.');
                    return;
                }

                if (this.clientSubscriptions.get(client_id)?.has(api_url)) {
                    this.sendMessageToClient(ws, { status: 'info', message: 'Ya estás suscrito a este servicio.' });
                    Logger.warn(`⚠️ Intento de suscripción duplicada para ${client_id} en la URL ${api_url}.`);
                    return;
                }

                Logger.info(`➡️  Iniciando suscripción de ${client_id} al servicio "${service}" en ${api_url}.`);

                const task = this.createTask(client_id, api_url, service, token);
                this.saveTask(task);
                this.clientToTaskMap.set(ws, client_id);

                const subscribeResponse = await this.subscribeToApi(api_url, client_id, service, token);

                if (subscribeResponse.success) {
                    task.status = 'POR RECIBIR';
                    task.last_update = new Date().toISOString();
                    this.saveTask(task);
                    this.addClientSubscription(client_id, api_url);

                    this.sendMessageToClient(ws, { status: 'success', message: 'Suscripción exitosa. Esperando datos...' });
                    Logger.info(`✅ Suscripción exitosa para ${client_id}.`);
                } else {
                    this.deleteTask(task.client);
                    this.sendErrorToClient(ws, `Error al suscribirse a la API: ${subscribeResponse.message}`);
                    Logger.error(`❌ Falló la suscripción a la API para ${client_id}. Detalles: ${subscribeResponse.message}`);
                }
            } else {
                this.sendErrorToClient(ws, 'Operación no válida. Use "subscribe".');
                Logger.warn(`⚠️ Operación no reconocida desde ${client_id}. Operación solicitada: ${operation}.`);
            }
        } catch (error) {
            Logger.error('❌ Error al procesar el mensaje del cliente. Formato JSON inválido.', { error: error.message });
            this.sendErrorToClient(ws, 'Error en el formato del mensaje JSON.');
        }
    }

    handleWebhook(eventData) {
        const { suscription, operation, data } = eventData;
        const client_id = suscription; // La API REST debe enviar un ID de suscripción/cliente para identificar la tarea
        Logger.info(`📥 Webhook recibido para cliente ${client_id}. Operación: ${operation}.`);

        const task = this.tasks.get(client_id);
        if (!task) {
            Logger.warn(`⚠️ Webhook recibido para un cliente no registrado: ${client_id}.`);
            return;
        }

        if (operation === 'receive') {
            task.last_result = data;
            task.status = 'POR ENVIAR';
            task.last_update = new Date().toISOString();
            this.saveTask(task);
            Logger.info(`📦 Tarea de cliente ${client_id} actualizada. Ahora en estado "POR ENVIAR".`);
        } else if (operation === 'delete') {
            Logger.warn(`⚠️ API solicita la eliminación de la tarea y desconexión de ${client_id}.`);
            const ws = this.getWsClientFromTask(task);
            if (ws) {
                this.sendMessageToClient(ws, { status: 'disconnected', message: 'Su sesión ha expirado o ha sido terminada por la API.' });
                ws.close(1000, 'Sesión terminada por la API.');
            }
            this.deleteTask(client_id);
        } else if (operation === 'pause') {
            task.status = 'PAUSADO';
            task.last_update = new Date().toISOString();
            this.saveTask(task);
            Logger.info(`⏸️ Tarea de cliente ${client_id} pausada.`);
        }
    }

    pollAndSendTasks() {
        Logger.info('🔍 Iniciando sondeo de tareas pendientes...');
        this.tasks.forEach(task => {
            if (task.status === 'POR ENVIAR') {
                const ws = this.getWsClientFromTask(task);
                if (ws && ws.readyState === WebSocket.OPEN) {
                    this.sendMessageToClient(ws, { status: 'data', service: task.service, data: task.last_result });
                    task.status = 'POR RECIBIR';
                    task.last_update = new Date().toISOString();
                    this.saveTask(task);
                    Logger.info(`🚀 Respuesta enviada al cliente ${task.client}. Tarea actualizada a "POR RECIBIR".`);
                } else {
                    Logger.warn(`⚠️ Cliente ${task.client} no está conectado. La tarea se mantiene en "POR ENVIAR".`);
                }
            }
        });
    }

    cleanUp(ws) {
        const client_id = this.clientToTaskMap.get(ws);
        if (!client_id) return;

        const task = this.tasks.get(client_id);
        if (task) {
            this.unsubscribeFromApi(task.api_url, client_id);
            this.deleteTask(client_id);
        }
        
        this.clientSubscriptions.delete(client_id);
        this.clientToTaskMap.delete(ws);
        Logger.info(`🧹 Limpieza de suscripciones y tareas completada para el cliente ${client_id}.`);
    }

    // --- Métodos de Gestión de Tareas ---

    getClientId(ws) {
        return `${ws._socket.remoteAddress}:${ws._socket.remotePort}`;
    }

    getWsClientFromTask(task) {
        for (const [ws, taskId] of this.clientToTaskMap.entries()) {
            if (taskId === task.client) {
                return ws;
            }
        }
        return null;
    }

    createTask(client_id, api_url, service, token) {
        const task = {
            client: client_id,
            api_url: api_url,
            service: service,
            token: token,
            status: 'INICIANDO',
            last_update: new Date().toISOString(),
            last_result: ''
        };
        this.tasks.set(client_id, task);
        return task;
    }

    saveTask() {
        const tasksArray = Array.from(this.tasks.values());
        fs.writeFileSync(TASKS_FILE, JSON.stringify(tasksArray, null, 2), 'utf8');
    }

    deleteTask(client_id) {
        this.tasks.delete(client_id);
        this.saveTask();
    }

    addClientSubscription(client_id, api_url) {
        if (!this.clientSubscriptions.has(client_id)) {
            this.clientSubscriptions.set(client_id, new Set());
        }
        this.clientSubscriptions.get(client_id).add(api_url);
    }

    // --- Métodos de Comunicación con API ---

    async subscribeToApi(api_url, client_id, service, token) {
        const subscriptionUrl = `${api_url}/subscribe`;
        try {
            const response = await axios.post(subscriptionUrl, {
                service,
                client_id,
                token,
                webhook_url: `${process.env.SERVER_URL}/webhook`
            }, { timeout: API_TIMEOUT });
            return { success: true, message: response.data.message };
        } catch (error) {
            Logger.error(`❌ Error al suscribir a la API ${api_url}`, { error: error.message });
            return { success: false, message: 'Fallo la conexión o la suscripción en la API.' };
        }
    }

    async unsubscribeFromApi(api_url, client_id) {
        const unsubscribeUrl = `${api_url}/unsubscribe`;
        try {
            await axios.post(unsubscribeUrl, { client_id }, { timeout: API_TIMEOUT });
            Logger.info(`Petición de desuscripción enviada para el cliente ${client_id} a ${api_url}.`);
        } catch (error) {
            Logger.error(`❌ Error al desuscribir de la API ${api_url}`, { error: error.message });
        }
    }

    // --- Métodos de Comunicación con Clientes ---
    sendMessageToClient(ws, message) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        }
    }

    sendErrorToClient(ws, errorMessage) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ status: 'error', message: errorMessage }));
        }
    }
}

module.exports = TaskScheduler;