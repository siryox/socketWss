// src/TaskScheduler.js
const fs = require('fs');
const path = require('path');
const https = require('https');
require('dotenv').config();

const TASKS_FILE = path.join(__dirname, 'tasks.json');
const DEFAULT_TASK_EXECUTIONS = process.env.DEFAULT_TASK_EXECUTIONS ? parseInt(process.env.DEFAULT_TASK_EXECUTIONS) : 1;

class TaskScheduler {
    constructor() {
        this.tasks = this.loadTasks();
        this.interval = null;
        console.log(`✅ Tareas cargadas: ${this.tasks.length}`);
        }

    // Carga las tareas desde el archivo tasks.json
    loadTasks() {
     console.log('Cargando tareas existentes desde el archivo...');

    if (fs.existsSync(TASKS_FILE)) {
        try {
                const data = fs.readFileSync(TASKS_FILE, 'utf8');
                return JSON.parse(data);
            } catch (error) {
            console.error('❌ Error al leer o parsear el archivo de tareas:', error.message);
            return [];
        }
    } else {
         console.log('⚠️ No se encontró el archivo de tareas. Iniciando con una lista vacía.');
         return [];
        }
    }

 // Guarda el array de tareas en el archivo tasks.json
     saveTasks() {
        try {
            const data = JSON.stringify(this.tasks, null, 2);
            fs.writeFileSync(TASKS_FILE, data, 'utf8');
            console.log('📁 Tareas guardadas en el archivo.');
        } catch (error) {
             console.error('❌ Error al guardar las tareas:', error.message);
      }
    }

// Retorna todas las tareas
    getTasks() {
      return this.tasks;
    }

// Agrega una nueva tarea si no existe y la guarda
    addTask(taskData, ws) {
         const taskId = `${taskData.url_api_destino}-${taskData.metodo_peticion}-${Date.now()}`;

         const taskExists = this.tasks.some(task => task.id === taskId);

     if (!taskExists) {
         const totalExecutions = taskData.ejecuciones_totales || DEFAULT_TASK_EXECUTIONS;
         const newTask = {
                id: taskId,
                ws: ws,
                 url_api_destino: taskData.url_api_destino,
                 metodo_peticion: taskData.metodo_peticion,
                 body_peticion: taskData.body_peticion || null,
                 inicio_ejecucion: taskData.inicio_ejecucion || Date.now(),
                 ejecutandose_hasta_cierre: taskData.ejecutandose_hasta_cierre || false,
                 ejecuciones_totales: totalExecutions,
                 ejecuciones_actuales: 0,
                 estado: 'pendiente',
                ultima_respuesta: null
         };
            this.tasks.push(newTask);
            this.saveTasks();
            console.log('✅ Nueva tarea agregada y guardada:', newTask.id);
            return newTask;
     } else {
         console.log('⚠️ La tarea ya existe, no se ha agregado:', taskId);
         return null;
     }
 }

 // --- LÓGICA DE PROGRAMACIÓN Y EJECUCIÓN ---
 startScheduler() {
 if (this.interval) {
     console.log('El planificador ya está en ejecución.');
         return;
    }

    const checkInterval = (60 * 1000) / DEFAULT_TASK_EXECUTIONS;

    this.interval = setInterval(() => {
        console.log('🔎 Revisando tareas para ejecutar...');
        const now = Date.now();

        this.tasks.forEach(task => {
            const shouldExecute = 
            task.estado === 'pendiente' &&
            new Date(task.inicio_ejecucion).getTime() <= now;

         if (shouldExecute) {
             console.log(`🚀 Ejecutando tarea: ${task.id}`);
             this.makeApiRequest(task);

            if (!task.ejecutandose_hasta_cierre) {
                task.ejecuciones_actuales++;
                if (task.ejecuciones_actuales >= task.ejecuciones_totales) {
                    ask.estado = 'completada';
                    console.log(`✅ Tarea completada: ${task.id}`);
                 }
            }
        }
     });
       this.saveTasks();
    }, checkInterval);
 }

 makeApiRequest(task) {
     const { url_api_destino, metodo_peticion, body_peticion, ws } = task;

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
                    console.log(`Respuesta de la API para ${task.id}:`, responseData);
                    task.ultima_respuesta = responseData;
                    
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ 
                            taskId: task.id, 
                            status: 'success', 
                            data: responseData 
                        }));
                    }
                } catch (error) {
                    console.error(`❌ Error al analizar la respuesta JSON para la tarea ${task.id}:`, error.message);
                    task.estado = 'error';
                    task.ultima_respuesta = { error: `Error al analizar la respuesta JSON: ${error.message}` };
                    
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ 
                            taskId: task.id, 
                            status: 'error', 
                            message: `Error al analizar la respuesta JSON: ${error.message}`
                        }));
                    }
                }
            });
        });

        req.on('error', err => {
            console.error('Error en la petición a la API:', err.message);
            task.estado = 'error';
            task.ultima_respuesta = { error: `Error en la petición a la API: ${err.message}` };
            this.saveTasks(); // Persistimos el error inmediatamente
            
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ 
                    taskId: task.id, 
                    status: 'error', 
                    message: `Error en la petición a la API: ${err.message}`
                }));
            }
        });

        if (body_peticion) {
            req.write(JSON.stringify(body_peticion));
        }
        
        req.end();
    }
}

module.exports = TaskScheduler;