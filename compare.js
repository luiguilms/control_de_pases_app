const { ipcRenderer } = require('electron');

// Función para formatear fechas
function formatDate(dateObj) {
    if (!dateObj) return 'N/A';
    
    const date = new Date(dateObj);
    
    // Verificar si es una fecha válida
    if (isNaN(date.getTime())) return 'N/A';
    
    // Formatear como DD/MM/YYYY HH:MM:SS
    return new Intl.DateTimeFormat('es', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    }).format(date);
}

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

// Función para mostrar las fechas en la interfaz
function displayDates(objectDates, fileDates) {
    const dateInfoContainer = document.getElementById('date-info');
    if (!dateInfoContainer) return;
    
    const dbCreated = formatDate(objectDates?.created);
    const dbModified = formatDate(objectDates?.lastModified);
    const fileCreated = formatDate(fileDates?.created);
    const fileModified = formatDate(fileDates?.modified);
    
    dateInfoContainer.innerHTML = `
        <div class="date-column">
            <h4>Base de Datos</h4>
            <div class="date-item">
                <span class="date-label">Creado:</span>
                <span class="date-value">${dbCreated}</span>
            </div>
            <div class="date-item">
                <span class="date-label">Modificado:</span>
                <span class="date-value">${dbModified}</span>
            </div>
        </div>
        <div class="date-column">
            <h4>Archivo Local</h4>
            <div class="date-item">
                <span class="date-label">Creado:</span>
                <span class="date-value">${fileCreated}</span>
            </div>
            <div class="date-item">
                <span class="date-label">Modificado:</span>
                <span class="date-value">${fileModified}</span>
            </div>
        </div>
    `;
}

// Función para extraer esquema del contenido del archivo
function extractSchemaFromContent(fileContent, objectType) {
    // Normalizar el contenido para facilitar la búsqueda
    const content = fileContent.toString().toUpperCase();
    
    // Patrones a buscar según el tipo de objeto
    let patterns = [
        new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+${objectType}\\s+(\\w+)\\.`, 'i'),
        new RegExp(`CREATE\\s+${objectType}\\s+(\\w+)\\.`, 'i')
    ];
    
    // También para casos de PACKAGE BODY
    if (objectType === 'PACKAGE') {
        patterns.push(new RegExp('CREATE\\s+OR\\s+REPLACE\\s+PACKAGE\\s+BODY\\s+(\\w+)\\.', 'i'));
        patterns.push(new RegExp('CREATE\\s+PACKAGE\\s+BODY\\s+(\\w+)\\.', 'i'));
    }
    
    // Probar cada patrón
    for (const pattern of patterns) {
        const match = content.match(pattern);
        if (match && match[1]) {
            return match[1];
        }
    }
    
    return null;
}

// Función para analizar el nombre del objeto a partir del contenido
function extractObjectNameFromContent(fileContent, objectType) {
    // Normalizar el contenido para facilitar la búsqueda
    const content = fileContent.toString().toUpperCase();
    
    // Patrones a buscar según el tipo de objeto
    let patterns = [
        new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+${objectType}\\s+\\w+\\.(\\w+)`, 'i'),
        new RegExp(`CREATE\\s+${objectType}\\s+\\w+\\.(\\w+)`, 'i')
    ];
    
    // También para casos de PACKAGE BODY
    if (objectType === 'PACKAGE') {
        patterns.push(new RegExp('CREATE\\s+OR\\s+REPLACE\\s+PACKAGE\\s+BODY\\s+\\w+\\.(\\w+)', 'i'));
        patterns.push(new RegExp('CREATE\\s+PACKAGE\\s+BODY\\s+\\w+\\.(\\w+)', 'i'));
    }
    
    // Probar cada patrón
    for (const pattern of patterns) {
        const match = content.match(pattern);
        if (match && match[1]) {
            return match[1];
        }
    }
    
    return null;
}

// Verificar y completar los campos según el contenido del archivo
function autoFillFromFileContent(fileContent) {
    // Intentar determinar el tipo de objeto desde el contenido
    let detectedType = null;
    
    if (fileContent.toUpperCase().includes('PACKAGE BODY')) {
        detectedType = 'PACKAGE';
    } else if (fileContent.toUpperCase().includes('PACKAGE') && !fileContent.toUpperCase().includes('PACKAGE BODY')) {
        detectedType = 'PACKAGE';
    } else if (fileContent.toUpperCase().includes('FUNCTION')) {
        detectedType = 'FUNCTION';
    } else if (fileContent.toUpperCase().includes('PROCEDURE')) {
        detectedType = 'PROCEDURE';
    }
    
    // Si se detectó un tipo, actualizar el select
    if (detectedType) {
        const objectTypeSelect = document.getElementById('objectType');
        for (let i = 0; i < objectTypeSelect.options.length; i++) {
            if (objectTypeSelect.options[i].value === detectedType) {
                objectTypeSelect.selectedIndex = i;
                break;
            }
        }
    }
    
    // Intentar extraer el esquema
    const schema = extractSchemaFromContent(fileContent, detectedType || document.getElementById('objectType').value);
    if (schema) {
        document.getElementById('schemaInput').value = schema;
    }
    
    // Intentar extraer el nombre del objeto
    const objectName = extractObjectNameFromContent(fileContent, detectedType || document.getElementById('objectType').value);
    if (objectName) {
        document.getElementById('objectInput').value = objectName;
    }
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

    if (options.objectDates || options.fileDates) {
        displayDates(options.objectDates, options.fileDates);
    }
    
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
                dbLines.push('<span class="removed diff-line empty-line"><span class="diff-marker">-</span> </span>');
                // No añadir nada en file-code para evitar espacio extra
            } else if (part.added) {
                // Añadir la línea vacía en file-code
                fileLines.push('<span class="added diff-line empty-line"><span class="diff-marker">+</span> </span>');
                // Añadir un spacer en db-code para mantener alineación
                dbLines.push('<span class="spacer diff-line empty-line"> </span>');
            }
            return;
        }

        const lines = part.value.split('\n').filter(line => line !== '');
        lines.forEach((line, index) => {
            const lineHtml = line.replace(/\s/g, match => match === ' ' ? ' ' : match === '\t' ? '    ' : match) || ' ';
            const isLastLine = index === lines.length - 1;
            const needsLineBreak = !isLastLine || (part.value.endsWith('\n') && !isLastLine);

            if (part.added) {
                fileLines.push(`<span class="added diff-line"><span class="diff-marker">+</span>${lineHtml}</span>${needsLineBreak ? '\n' : ''}`);
                if (index === 0) dbLines.push('<span class="spacer diff-line"> </span>');
            } else if (part.removed) {
                dbLines.push(`<span class="removed diff-line"><span class="diff-marker">-</span>${lineHtml}</span>${needsLineBreak ? '\n' : ''}`);
                if (index === 0) fileLines.push('<span class="spacer diff-line"> </span>');
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

// Auto-detección de esquema y nombre al seleccionar un archivo
document.getElementById('fileInput').addEventListener('change', function(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(e) {
        const fileContent = e.target.result;
        autoFillFromFileContent(fileContent);
    };
    reader.onerror = function() {
        showNotification("Error al leer el archivo.", true);
    };
    reader.readAsText(file, 'ISO-8859-1');
});

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

    // También limpiar la información de fechas si existe
    const dateInfo = document.getElementById('date-info');
    if (dateInfo) dateInfo.innerHTML = '';
    
    const reader = new FileReader();
    reader.onload = function (event) {
        const fileContent = event.target.result;
        
        // Auto-detección de esquema desde el contenido como respaldo
        const detectedSchema = extractSchemaFromContent(fileContent, objectType);
        const filePath = fileInput.value; // Esto debería funcionar en Electron
        // Usar el esquema detectado si no coincide con el ingresado manualmente y mostrar notificación
        if (detectedSchema && detectedSchema !== schema) {
            showNotification(`Se detectó un esquema diferente en el archivo (${detectedSchema}). Usando el esquema detectado.`, false);
            
            ipcRenderer.send('compare-code', {
                fileContent,
                schema: detectedSchema,
                objectType,
                objectName,
                filePath
            });
        } else {
            // Usar el esquema ingresado por el usuario
            ipcRenderer.send('compare-code', {
                fileContent,
                schema,
                objectType,
                objectName,
                filePath
            });
        }
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
            // Extraer información de fechas
            if ('objectDates' in parsedResponse) {
                options.objectDates = parsedResponse.objectDates;
            }
            if ('fileDates' in parsedResponse) {
                options.fileDates = parsedResponse.fileDates;
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