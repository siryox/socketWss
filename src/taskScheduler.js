// src/TaskScheduler.js
const Logger = require('../src/logger');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const TASKS_FILE = path.resolve(__dirname, '../src/tasks.json');
const POLL_INTERVAL = 5000; // Sondeo cada 5 segundos
const API_TIMEOUT = 5000; // 5 segundos de timeout para la API

class TaskScheduler {
    constructor() {
        this.tasks = new Map(); // Mapa de tareas por client_id
        this.clientToTaskMap = new Map(); // Mapa de cliente WebSocket a task_id
        this.clientSubscriptions = new Map(); // Mapa de suscripciones por cliente
        this.init();
    }

    init() {
        // Inicializa el sondeo para enviar respuestas pendientes
        setInterval(() => this.pollAndSendTasks(), POLL_INTERVAL);
        Logger.info('TaskScheduler inicializado y proceso de sondeo activado.');
    }

    /**
     * @description Maneja los mensajes entrantes de los clientes WebSocket.
     * @param {WebSocket} ws Cliente WebSocket.
     * @param {string} message Mensaje recibido en formato JSON.
     */
    async handleClientMessage(ws, message) {
        try {
            const data = JSON.parse(message);
            const { service, token, api_url, operation } = data;

            if (operation === 'subscribe') {
                const client_id = this.getClientId(ws);
                if (!client_id) {
                    this.sendErrorToClient(ws, 'No se pudo identificar al cliente.');
                    return;
                }

                if (this.clientSubscriptions.get(client_id)?.has(api_url)) {
                    this.sendMessageToClient(ws, { status: 'info', message: 'Ya estás suscrito a este servicio.' });
                    return;
                }

                // 1. Crear la tarea y guardarla
                const task = this.createTask(client_id, api_url, service, token);
                this.saveTask(task);

                // 2. Enviar la petición de suscripción a la API REST
                const subscribeResponse = await this.subscribeToApi(api_url, client_id, service, token);

                if (subscribeResponse.success) {
                    // Actualizar la tarea y el mapa de suscripciones
                    task.status = 'POR RECIBIR';
                    task.last_update = new Date().toISOString();
                    this.saveTask(task);
                    this.addClientSubscription(client_id, api_url);

                    this.sendMessageToClient(ws, { status: 'success', message: 'Suscripción exitosa. Esperando datos...' });
                } else {
                    // Si la suscripción falla, eliminar la tarea
                    this.deleteTask(task.client);
                    this.sendErrorToClient(ws, `Error al suscribirse a la API: ${subscribeResponse.message}`);
                }

            } else {
                this.sendErrorToClient(ws, 'Operación no válida. Use "subscribe".');
            }
        } catch (error) {
            Logger.error('Error al procesar el mensaje del cliente.', { error: error.message });
            this.sendErrorToClient(ws, 'Error en el formato del mensaje JSON.');
        }
    }

    /**
     * @description Maneja los eventos entrantes del webhook de la API REST.
     * @param {object} eventData Datos del evento del webhook.
     */
    handleWebhook(eventData) {
        const { client_id, response, operation, data } = eventData;

        // Buscar la tarea por el client_id
        const task = this.tasks.get(client_id);
        if (!task) {
            Logger.warn(`Webhook recibido para un cliente no registrado: ${client_id}`);
            return;
        }

        if (operation === 'receive') {
            task.last_result = data;
            task.status = 'POR ENVIAR';
            task.last_update = new Date().toISOString();
            Logger.info(`Tarea de cliente ${client_id} actualizada a POR ENVIAR.`);
            this.saveTask(task);
        } else if (operation === 'delete') {
            Logger.warn(`API solicita eliminar la tarea y desconectar al cliente ${client_id}.`);
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
            Logger.info(`Tarea de cliente ${client_id} pausada.`);
        }
    }

    /**
     * @description Proceso de sondeo que busca y envía las tareas con estado 'POR ENVIAR'.
     */
    pollAndSendTasks() {
        Logger.info('Iniciando sondeo de tareas...');
        this.tasks.forEach(task => {
            if (task.status === 'POR ENVIAR') {
                const ws = this.getWsClientFromTask(task);
                if (ws && ws.readyState === WebSocket.OPEN) {
                    this.sendMessageToClient(ws, { status: 'data', service: task.service, data: task.last_result });
                    // Actualizar el estado de la tarea a 'POR RECIBIR'
                    task.status = 'POR RECIBIR';
                    task.last_update = new Date().toISOString();
                    this.saveTask(task);
                    Logger.info(`Respuesta enviada al cliente ${task.client}. Tarea actualizada a POR RECIBIR.`);
                } else {
                    Logger.warn(`Cliente ${task.client} no está conectado o listo. La tarea se mantiene en POR ENVIAR.`);
                }
            }
        });
    }

    /**
     * @description Limpia las tareas y suscripciones cuando un cliente se desconecta.
     * @param {WebSocket} ws Cliente WebSocket.
     */
    cleanUp(ws) {
        const client_id = this.getClientId(ws);
        if (!client_id) return;

        // Desuscribir de la API y eliminar la tarea del archivo
        const task = this.tasks.get(client_id);
        if (task) {
            this.unsubscribeFromApi(task.api_url, client_id);
            this.deleteTask(client_id);
        }
        
        // Limpiar el mapa de suscripciones del cliente
        this.clientSubscriptions.delete(client_id);
        Logger.info(`Limpieza de suscripciones y tareas completada para el cliente ${client_id}.`);
    }

    // --- Métodos de Gestión de Tareas ---

    getClientId(ws) {
        // En un entorno de producción, un ID más robusto sería necesario.
        // Aquí se usa un hash simple de la dirección y el puerto.
        if (ws._socket) {
            return `${ws._socket.remoteAddress}:${ws._socket.remotePort}`;
        }
        return null;
    }

    getWsClientFromTask(task) {
        const client_id = task.client;
        for (const [ws, task_id] of this.clientToTaskMap.entries()) {
            if (task_id === client_id) {
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

    saveTask(task) {
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
        // También se puede usar clientToTaskMap aquí para mapear el WebSocket al ID de la tarea
    }

    // --- Métodos de Comunicación con API ---

    async subscribeToApi(api_url, client_id, service, token) {
        const subscriptionUrl = `${api_url}/subscribe`; // URL de suscripción en la API
        try {
            const response = await axios.post(subscriptionUrl, {
                service,
                client_id,
                token,
                webhook_url: `${process.env.SERVER_URL || 'http://localhost:8443'}/webhook`
            }, { timeout: API_TIMEOUT });
            return { success: true, message: response.data.message };
        } catch (error) {
            Logger.error(`Error al suscribir a la API ${api_url}`, { error: error.message });
            return { success: false, message: 'Fallo la conexión o la suscripción en la API.' };
        }
    }

    async unsubscribeFromApi(api_url, client_id) {
        const unsubscribeUrl = `${api_url}/unsubscribe`; // URL de desuscripción en la API
        try {
            await axios.post(unsubscribeUrl, { client_id }, { timeout: API_TIMEOUT });
            Logger.info(`Petición de desuscripción enviada para el cliente ${client_id} a ${api_url}.`);
        } catch (error) {
            Logger.error(`Error al desuscribir de la API ${api_url}`, { error: error.message });
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