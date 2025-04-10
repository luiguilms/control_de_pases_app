const { ipcRenderer } = require('electron');
const path = require('path');

// Elementos del DOM
const folderPathInput = document.getElementById('folderPath');
const browseButton = document.getElementById('browseButton');
const scanButton = document.getElementById('scanButton');
const schemaInput = document.getElementById('schemaInput');
const fileListContainer = document.getElementById('fileList').querySelector('tbody');
const emptyMessage = document.getElementById('emptyMessage');
const searchInput = document.getElementById('searchFiles');
const fileTypeFilters = document.querySelectorAll('.file-type-filter');
const batchLoader = document.getElementById('batchLoader');

// Elementos del modal
const compareModal = document.getElementById('compareModal');
const modalTitle = document.getElementById('fileName');
const modalDbCode = document.getElementById('modal-db-code');
const modalFileCode = document.getElementById('modal-file-code');
const modalResultSummary = document.getElementById('modalResultSummary');
const modalLoader = document.getElementById('modalLoader');
const modalNotification = document.getElementById('modalNotification');
const modalShowOnlyDiff = document.getElementById('modalShowOnlyDiff');
const closeModal = document.querySelector('.close-modal');

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

function extractSchemaAndName(fileName) {
    // Eliminar la extensión
    const baseName = path.basename(fileName, path.extname(fileName));
    
    // Patrón común: ESQUEMA_NOMBREOBJETO o ESQUEMA.NOMBREOBJETO
    const parts = baseName.split(/[_.]/);
    
    if (parts.length >= 2) {
        // Asumimos que el primer componente es el esquema
        return {
            schema: parts[0].toUpperCase(),
            objectName: parts.slice(1).join('_').toUpperCase()
        };
    } else {
        // Si no podemos separar, usamos el nombre completo
        return {
            schema: null,
            objectName: baseName.toUpperCase()
        };
    }
}
// Array para almacenar los archivos encontrados
let filesFound = [];

// Función para mostrar/ocultar el indicador de carga
function toggleLoader(elementId, show) {
    document.getElementById(elementId).style.display = show ? 'block' : 'none';
}

// Función para mostrar notificación en el modal
function showModalNotification(message, isError = false) {
    modalNotification.textContent = message;
    modalNotification.className = `notification ${isError ? 'error' : 'success'}`;
    modalNotification.style.display = 'block';
    
    // Ocultar la notificación después de 5 segundos
    setTimeout(() => {
        modalNotification.style.display = 'none';
    }, 5000);
}

// Función para explorar carpetas
browseButton.addEventListener('click', () => {
    ipcRenderer.send('open-folder-dialog');
});

// Recibir la ruta de la carpeta seleccionada
ipcRenderer.on('selected-folder', (event, folderPath) => {
    if (folderPath) {
        folderPathInput.value = folderPath;
    }
});

// Función para escanear archivos
scanButton.addEventListener('click', () => {
    const folderPath = folderPathInput.value.trim();
    
    if (!folderPath) {
        alert("Por favor, seleccione una carpeta para escanear.");
        return;
    }
    
    // Mostrar el indicador de carga
    toggleLoader('batchLoader', true);
    
    // Limpiar la lista de archivos previa
    fileListContainer.innerHTML = '';
    emptyMessage.style.display = 'none';
    filesFound = [];
    
    // Enviar solicitud al proceso principal para escanear la carpeta
    ipcRenderer.send('scan-folder', { folderPath, extensions: ['.pck', '.fnc', '.prc'] });
});

// Procesar los resultados del escaneo
ipcRenderer.on('scan-results', (event, files) => {
    // Ocultar el indicador de carga
    toggleLoader('batchLoader', false);
    
    // Guardar los archivos encontrados
    filesFound = files.map(file => {
        const extension = path.extname(file).toLowerCase();
        let type = 'Desconocido';
        
        switch (extension) {
            case '.pck':
                type = 'PACKAGE';
                break;
            case '.fnc':
                type = 'FUNCTION';
                break;
            case '.prc':
                type = 'PROCEDURE';
                break;
        }
        
        const { schema, objectName } = extractSchemaAndName(path.basename(file));
        
        return {
            path: file,
            name: path.basename(file),
            schema: schema,
            objectName: objectName,
            type: type,
            extension: extension
        };
    });
    
    // Mostrar los archivos
    displayFiles(filesFound);
});

// Función para mostrar los archivos en la tabla
function displayFiles(files) {
    fileListContainer.innerHTML = '';
    
    if (files.length === 0) {
        emptyMessage.style.display = 'block';
        return;
    }
    
    emptyMessage.style.display = 'none';
    
    files.forEach(file => {
        const row = document.createElement('tr');
        
        // Columna de nombre
        const nameCell = document.createElement('td');
        nameCell.textContent = file.name;
        row.appendChild(nameCell);
        
        // Columna de tipo
        const typeCell = document.createElement('td');
        typeCell.textContent = file.type;
        row.appendChild(typeCell);
        
        // Columna de acciones
        const actionCell = document.createElement('td');
        const compareButton = document.createElement('button');
        compareButton.textContent = 'Comparar';
        compareButton.className = 'compare-button';
        compareButton.dataset.filepath = file.path;
        compareButton.dataset.objectType = file.type;
        compareButton.dataset.objectName = path.basename(file.name, path.extname(file.name));
        
        compareButton.addEventListener('click', handleCompareClick);
        
        actionCell.appendChild(compareButton);
        row.appendChild(actionCell);
        
        fileListContainer.appendChild(row);
    });
}

// Función para manejar la búsqueda de archivos
searchInput.addEventListener('input', filterFiles);

// Función para manejar el filtrado por tipo de archivo
fileTypeFilters.forEach(filter => {
    filter.addEventListener('change', filterFiles);
});

// Función para filtrar archivos
function filterFiles() {
    const searchTerm = searchInput.value.toLowerCase();
    const activeExtensions = Array.from(fileTypeFilters)
        .filter(filter => filter.checked)
        .map(filter => filter.value);
    
    const filteredFiles = filesFound.filter(file => {
        const matchesSearch = file.name.toLowerCase().includes(searchTerm);
        const matchesExtension = activeExtensions.includes(file.extension);
        
        return matchesSearch && matchesExtension;
    });
    
    displayFiles(filteredFiles);
}

// Función para comparar código al hacer clic en el botón
// Función para comparar código al hacer clic en el botón
async function handleCompareClick(event) {
    console.log("Botón Comparar clickeado");
    
    const button = event.currentTarget;
    console.log("Dataset del botón:", button.dataset);
    
    const filePath = button.dataset.filepath;
    const objectType = button.dataset.objectType;
    const objectName = button.dataset.objectName;
    
    console.log(`Datos: Ruta=${filePath}, Tipo=${objectType}, Nombre=${objectName}`);
    
    // Ya no verificamos el esquema aquí, lo extraeremos del contenido del archivo
    
    // Mostrar el modal
    compareModal.style.display = 'block';
    modalTitle.textContent = path.basename(filePath);
    
    // Limpiar contenidos previos
    modalDbCode.innerHTML = '';
    modalFileCode.innerHTML = '';
    modalResultSummary.textContent = '';
    modalNotification.style.display = 'none';
    
    // Mostrar loader
    toggleLoader('modalLoader', true);
    
    try {
        console.log("Enviando solicitud para leer archivo:", filePath);
        // Leer el contenido del archivo
        ipcRenderer.send('read-file', filePath);
    } catch (error) {
        console.error("Error al intentar leer el archivo:", error);
        toggleLoader('modalLoader', false);
        showModalNotification(`Error al leer el archivo: ${error.message}`, true);
    }
}

// Modificar la función que recibe el contenido del archivo
ipcRenderer.on('file-content', (event, fileContent) => {
    console.log("Evento file-content recibido", fileContent ? "con contenido" : "sin contenido");
    
    if (!fileContent) {
        toggleLoader('modalLoader', false);
        showModalNotification('Error al leer el archivo o archivo vacío', true);
        return;
    }
    
    const button = document.querySelector('.compare-button:focus') || document.activeElement;
    
    if (!button || !button.classList.contains('compare-button')) {
        console.log("No se encontró un botón de comparación activo");
        return;
    }
    
    const objectType = button.dataset.objectType;
    const objectName = button.dataset.objectName;
    
    // Intentar extraer el esquema del contenido del archivo
    const schema = extractSchemaFromContent(fileContent, objectType);
    
    if (!schema) {
        toggleLoader('modalLoader', false);
        showModalNotification(`No se pudo detectar el esquema en el contenido del archivo. Verifica que el archivo contiene una declaración válida con formato: CREATE OR REPLACE ${objectType} ESQUEMA.NOMBRE`, true);
        return;
    }
    
    console.log(`Esquema extraído del contenido: ${schema}`);
    console.log(`Enviando comparación: ${schema}.${objectName} [${objectType}]`);
    
    // Enviar datos para comparación
    ipcRenderer.send('compare-code', {
        fileContent,
        schema,
        objectType,
        objectName
    });
});

// Recibir y mostrar resultado de comparación
ipcRenderer.on('compare-response', (event, response) => {
    // Ocultar el indicador de carga
    toggleLoader('modalLoader', false);
    
    try {
        // Verificar si la respuesta es un error
        if (typeof response === 'string' && response.startsWith('Error')) {
            showModalNotification(response, true);
            return;
        }
        
        // Parsear la respuesta
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
            console.log("Error al parsear la respuesta:", e);
            showModalNotification("Error al procesar la respuesta", true);
            return;
        }
        
        // Mostrar la comparación lado a lado
        if (differences) {
            displayModalComparison(dbCode, fileContent, differences, options);
        }
        
    } catch (error) {
        console.error('Error al procesar la respuesta:', error);
        showModalNotification('Error al procesar la respuesta: ' + error.message, true);
    }
});

// Función para mostrar la comparación en el modal
function displayModalComparison(dbCode, fileContent, differences, options = {}) {
    modalDbCode.innerHTML = '';
    modalFileCode.innerHTML = '';
    
    const existingPackageInfo = document.querySelectorAll('.package-info');
    existingPackageInfo.forEach(info => info.remove());
    
    let hasDifferences = differences.some(part => part.added || part.removed);
    modalResultSummary.innerHTML = hasDifferences 
        ? '<span style="vertical-align: middle;">📌 Se encontraron diferencias entre los códigos.</span>'
        : '<span style="vertical-align: middle;">✅ Los archivos son completamente iguales.</span>';
    
    if (!hasDifferences) showModalNotification('Los archivos son completamente iguales.');
    
    if (options.specCodePresent || options.bodyCodePresent) {
        let packageInfoText = '';
        if (options.specCodePresent && options.bodyCodePresent) packageInfoText = 'El objeto contiene tanto PACKAGE como PACKAGE BODY.';
        else if (options.specCodePresent) packageInfoText = 'El objeto contiene solo PACKAGE (sin BODY).';
        else if (options.bodyCodePresent) packageInfoText = 'El objeto contiene solo PACKAGE BODY (sin especificación).';
        if (packageInfoText) {
            const infoElement = document.createElement('div');
            infoElement.className = 'package-info';
            infoElement.textContent = packageInfoText;
            modalResultSummary.parentNode.insertBefore(infoElement, modalResultSummary.nextSibling);
        }
    }
    
    let dbLines = [];
    let fileLines = [];
    
    differences.forEach(part => {
        // Manejo especial para saltos de línea solos
        if (part.value === '\n') {
            if (part.removed) {
                dbLines.push('<span class="removed diff-line empty-line"><span class="diff-marker">-</span> </span>');
            } else if (part.added) {
                fileLines.push('<span class="added diff-line empty-line"><span class="diff-marker">+</span> </span>');
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
    modalDbCode.innerHTML = dbLines.join('\n');
    modalFileCode.innerHTML = fileLines.join('\n');
    synchronizeModalScroll();
}

// Función para sincronizar el scroll entre los paneles del modal
function synchronizeModalScroll() {
    modalDbCode.addEventListener('scroll', () => {
        modalFileCode.scrollTop = modalDbCode.scrollTop;
        modalFileCode.scrollLeft = modalDbCode.scrollLeft;
    });
    
    modalFileCode.addEventListener('scroll', () => {
        modalDbCode.scrollTop = modalFileCode.scrollTop;
        modalDbCode.scrollLeft = modalFileCode.scrollLeft;
    });
}

// Filtrar para mostrar solo diferencias
modalShowOnlyDiff.addEventListener('change', function() {
    const showOnlyDiff = this.checked;
    const unchangedElements = document.querySelectorAll('#modal-db-code .unchanged, #modal-file-code .unchanged');
    
    unchangedElements.forEach(element => {
        // Comprobamos si el elemento tiene contenido
        const hasText = element.textContent.trim() !== '';
        
        // Solo ocultamos elementos que tienen contenido
        if (hasText) {
            element.style.display = showOnlyDiff ? 'none' : 'block';
        }
    });
});

// Cerrar el modal
closeModal.addEventListener('click', () => {
    compareModal.style.display = 'none';
});

// También cerrar el modal al hacer clic fuera del contenido
window.addEventListener('click', (event) => {
    if (event.target === compareModal) {
        compareModal.style.display = 'none';
    }
});

// Evento para escuchar cuando se presiona la tecla Escape
window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && compareModal.style.display === 'block') {
        compareModal.style.display = 'none';
    }
});