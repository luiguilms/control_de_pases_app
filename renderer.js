const { ipcRenderer } = require('electron');

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