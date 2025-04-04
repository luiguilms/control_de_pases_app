const { ipcRenderer } = require('electron');

// Mostrar/ocultar el indicador de carga
function toggleLoader(show) {
    document.getElementById('loader').style.display = show ? 'block' : 'none';
}

// Mostrar notificación
function showNotification(message, isError = false) {
    const notification = document.getElementById('notification');
    notification.textContent = message;
    notification.className = `notification ${isError ? 'error' : 'success'}`;
    notification.style.display = 'block';
    
    // Ocultar la notificación después de 5 segundos
    setTimeout(() => {
        notification.style.display = 'none';
    }, 5000);
}

// Función para mostrar el código en los paneles
function displayCodeSideBySide(dbCode, fileCode, differences, options = {}) {
    const dbCodeElement = document.getElementById('db-code');
    const fileCodeElement = document.getElementById('file-code');
    const resultSummary = document.getElementById('result-summary');
    
    dbCodeElement.innerHTML = '';
    fileCodeElement.innerHTML = '';
    const existingPackageInfo = document.querySelectorAll('.package-info');
    existingPackageInfo.forEach(info => info.remove());
    
    let hasDifferences = differences.some(part => part.added || part.removed);
    resultSummary.innerHTML = hasDifferences 
        ? '<span style="vertical-align: middle;">📌 Se encontraron diferencias entre los códigos.</span>'
        : '<span style="vertical-align: middle;">✅ Los archivos son completamente iguales.</span>';
    if (!hasDifferences) showNotification('Los archivos son completamente iguales.');
    
    if (options.specCodePresent || options.bodyCodePresent) {
        let packageInfoText = '';
        if (options.specCodePresent && options.bodyCodePresent) packageInfoText = 'El objeto contiene tanto PACKAGE como PACKAGE BODY.';
        else if (options.specCodePresent) packageInfoText = 'El objeto contiene solo PACKAGE (sin BODY).';
        else if (options.bodyCodePresent) packageInfoText = 'El objeto contiene solo PACKAGE BODY (sin especificación).';
        if (packageInfoText) {
            const infoElement = document.createElement('div');
            infoElement.className = 'package-info';
            infoElement.textContent = packageInfoText;
            resultSummary.parentNode.insertBefore(infoElement, resultSummary.nextSibling);
        }
    }
    
    let dbLines = [];
    let fileLines = [];
    
    differences.forEach(part => {
        // Manejo especial para saltos de línea solos
        if (part.value === '\n') {
            if (part.removed) {
                // Añadir la línea vacía en db-code
                dbLines.push('<span class="removed diff-line empty-line"><span class="diff-marker">-</span> </span>');
                // No añadir nada en file-code para evitar espacio extra
            } else if (part.added) {
                // Añadir la línea vacía en file-code
                fileLines.push('<span class="added diff-line empty-line"><span class="diff-marker">+</span> </span>');
                // Añadir un spacer en db-code para mantener alineación
                dbLines.push('<span class="spacer diff-line empty-line"> </span>');
            }
            return;
        }

        const lines = part.value.split('\n').filter(line => line !== '');
        lines.forEach((line, index) => {
            const lineHtml = line.replace(/\s/g, match => match === ' ' ? ' ' : match === '\t' ? '    ' : match) || ' ';
            const isLastLine = index === lines.length - 1;
            const needsLineBreak = !isLastLine || (part.value.endsWith('\n') && !isLastLine);

            if (part.added) {
                fileLines.push(`<span class="added diff-line"><span class="diff-marker">+</span>${lineHtml}</span>${needsLineBreak ? '\n' : ''}`);
                if (index === 0) dbLines.push('<span class="spacer diff-line"> </span>');
            } else if (part.removed) {
                dbLines.push(`<span class="removed diff-line"><span class="diff-marker">-</span>${lineHtml}</span>${needsLineBreak ? '\n' : ''}`);
                if (index === 0) fileLines.push('<span class="spacer diff-line"> </span>');
            } else {
                dbLines.push(`<span class="unchanged diff-line">${lineHtml}</span>${needsLineBreak ? '\n' : ''}`);
                fileLines.push(`<span class="unchanged diff-line">${lineHtml}</span>${needsLineBreak ? '\n' : ''}`);
            }
        });
    });
    
    // Asegurar que cada línea esté separada por un salto de línea real
    dbCodeElement.innerHTML = dbLines.join('\n');
    fileCodeElement.innerHTML = fileLines.join('\n');
    synchronizeScroll();
}

// Función para sincronizar el scroll entre los paneles de código
function synchronizeScroll() {
    const dbCodeElement = document.getElementById('db-code');
    const fileCodeElement = document.getElementById('file-code');
    
    dbCodeElement.addEventListener('scroll', () => {
        fileCodeElement.scrollTop = dbCodeElement.scrollTop;
        fileCodeElement.scrollLeft = dbCodeElement.scrollLeft;
    });
    
    fileCodeElement.addEventListener('scroll', () => {
        dbCodeElement.scrollTop = fileCodeElement.scrollTop;
        dbCodeElement.scrollLeft = fileCodeElement.scrollLeft;
    });
}

// Enviar solicitud de comparación
document.getElementById('compareButton').addEventListener('click', () => {
    const fileInput = document.getElementById('fileInput').files[0];
    const schema = document.getElementById('schemaInput').value.trim();
    const objectType = document.getElementById('objectType').value;
    const objectName = document.getElementById('objectInput').value.trim();

    if (!schema || !objectName) {
        showNotification("Debes ingresar el esquema y el nombre del objeto.", true);
        return;
    }

    if (!fileInput) {
        showNotification("Debes seleccionar un archivo para comparar.", true);
        return;
    }

    // Mostrar el indicador de carga
    toggleLoader(true);
    
    // Limpiar resultados anteriores
    document.getElementById('db-code').innerHTML = '';
    document.getElementById('file-code').innerHTML = '';
    document.getElementById('result-summary').textContent = '';
    
    const reader = new FileReader();
    reader.onload = function (event) {
        ipcRenderer.send('compare-code', {
            fileContent: event.target.result,
            schema,
            objectType,
            objectName
        });
    };
    reader.onerror = function() {
        toggleLoader(false);
        showNotification("Error al leer el archivo.", true);
    };
    reader.readAsText(fileInput, 'ISO-8859-1'); // También puedes probar con 'windows-1252'
});

// Mostrar resultado de la comparación
ipcRenderer.on('compare-response', (event, response) => {
    // Ocultar el indicador de carga
    toggleLoader(false);
    
    try {
        // Verificar si la respuesta es un error
        if (typeof response === 'string' && response.startsWith('Error')) {
            showNotification(response, true);
            return;
        }
        
        // Parsear la respuesta si está en formato JSON
        let dbCode, fileContent, differences, options = {};
        
        try {
            const parsedResponse = JSON.parse(response);
            dbCode = parsedResponse.dbCode;
            fileContent = parsedResponse.fileContent;
            differences = parsedResponse.differences;
            
            // Extraer información adicional si está disponible
            if ('specCodePresent' in parsedResponse) {
                options.specCodePresent = parsedResponse.specCodePresent;
            }
            if ('bodyCodePresent' in parsedResponse) {
                options.bodyCodePresent = parsedResponse.bodyCodePresent;
            }
        } catch (e) {
            // Si no se puede parsear como JSON, asumimos que es la respuesta anterior
            console.log("Formato de respuesta anterior, procesando...");
            
            // Asignar un mensaje predeterminado si response es un string (formato antiguo)
            if (typeof response === 'string') {
                document.getElementById('result-summary').textContent = 
                    response.includes('completamente iguales') 
                        ? '✅ Los archivos son completamente iguales.'
                        : '📌 Se encontraron diferencias entre los códigos.';
                
                // Mostrar el HTML recibido directamente (compatibilidad con formato antiguo)
                document.getElementById('db-code').innerHTML = response;
                document.getElementById('file-code').innerHTML = '';
                return;
            }
        }
        
        // Mostrar la comparación lado a lado
        if (differences) {
            displayCodeSideBySide(dbCode, fileContent, differences, options);
        }
        
    } catch (error) {
        console.error('Error al procesar la respuesta:', error);
        showNotification('Error al procesar la respuesta: ' + error.message, true);
    }
});

// Filtrar para mostrar solo diferencias o todo el código
document.getElementById('showOnlyDiff').addEventListener('change', function() {
    const showOnlyDiff = this.checked;
    const unchangedElements = document.querySelectorAll('.unchanged');
    
    unchangedElements.forEach(element => {
        // Comprobamos si el elemento está dentro de un span que tiene contenido
        const hasText = element.textContent.trim() !== '';
        
        // Solo ocultamos elementos que tienen contenido
        if (hasText) {
            element.style.display = showOnlyDiff ? 'none' : 'block';
        }
    });
});