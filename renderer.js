const { ipcRenderer } = require('electron');

// Cuando se cargue el DOM, solicitar las conexiones
document.addEventListener('DOMContentLoaded', () => {
    // Solicitar la lista de conexiones
    ipcRenderer.send('get-tns-connections');
  });
  
  // Recibir la lista de conexiones y actualizar el selector
  ipcRenderer.on('tns-connections', (event, connections) => {
    const connectionSelect = document.getElementById('connectionSelect');
    connectionSelect.innerHTML = ''; // Limpiar opciones existentes
    
    if (Object.keys(connections).length > 0) {
      // Agregar cada conexión como una opción
      for (const alias of Object.keys(connections).sort()) { // Ordenar alfabéticamente
        const option = document.createElement('option');
        option.value = alias;
        option.textContent = alias;
        connectionSelect.appendChild(option);
      }
    } else {
        // Si no hay conexiones, mostrar un mensaje
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No se encontraron conexiones TNS';
        connectionSelect.appendChild(option);
    }
  });

document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const selectedConnection = document.getElementById('connectionSelect').value;
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    
    // Mostrar mensaje de carga
    const messageElement = document.getElementById('message');
    messageElement.textContent = 'Conectando...';
    messageElement.className = 'notification';
    
    // Deshabilitar el botón de envío mientras se procesa
    const submitButton = e.target.querySelector('button');
    submitButton.disabled = true;

    ipcRenderer.send('login-attempt', { username, password, selectedConnection });
});

ipcRenderer.on('login-response', (event, message) => {
    const messageElement = document.getElementById('message');
    const submitButton = document.querySelector('button[type="submit"]');
    
    // Habilitar el botón nuevamente
    submitButton.disabled = false;
    
    if (message.startsWith('Conexión exitosa')) {
        messageElement.textContent = message;
        messageElement.className = 'notification success-message';
        
        // Redireccionar después de un breve retraso para que el usuario vea el mensaje
        setTimeout(() => {
            window.location.href = 'compare.html';
        }, 1000);
    } else {
        messageElement.textContent = message;
        messageElement.className = 'notification error-message';
    }
});