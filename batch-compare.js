const { ipcRenderer } = require("electron");
const path = require("path");
const fs = require('fs'); // Añade esta línea



// Elementos del DOM
const folderPathInput = document.getElementById("folderPath");
const browseButton = document.getElementById("browseButton");
const scanButton = document.getElementById("scanButton");
const fileListContainer = document
  .getElementById("fileList")
  .querySelector("tbody");
const emptyMessage = document.getElementById("emptyMessage");
const searchInput = document.getElementById("searchFiles");
const fileTypeFilters = document.querySelectorAll(".file-type-filter");
const batchLoader = document.getElementById("batchLoader");

// Elementos del modal
const compareModal = document.getElementById("compareModal");
const modalTitle = document.getElementById("fileName");
const modalDbCode = document.getElementById("modal-db-code");
const modalFileCode = document.getElementById("modal-file-code");
const modalResultSummary = document.getElementById("modalResultSummary");
const modalLoader = document.getElementById("modalLoader");
const modalNotification = document.getElementById("modalNotification");
const modalShowOnlyDiff = document.getElementById("modalShowOnlyDiff");
const closeModal = document.querySelector(".close-modal");

// Añadir función para formatear fechas (igual que en compare.js)
function formatDate(dateObj) {
  if (!dateObj) return "N/A";

  const date = new Date(dateObj);

  // Verificar si es una fecha válida
  if (isNaN(date.getTime())) return "N/A";

  // Formatear como DD/MM/YYYY HH:MM:SS
  return new Intl.DateTimeFormat("es", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

// Añadir función para mostrar fechas en el modal
function displayModalDates(objectDates, fileDates) {
  if (!modalDateInfo) return;

  const dbCreated = formatDate(objectDates?.created);
  const dbModified = formatDate(objectDates?.lastModified);
  const fileCreated = formatDate(fileDates?.created);
  const fileModified = formatDate(fileDates?.modified);

  modalDateInfo.innerHTML = `
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

// Añadir función para obtener fechas de archivos
function getFileDates(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return {
      created: stats.birthtime,
      modified: stats.mtime,
    };
  } catch (error) {
    console.error("Error al obtener fechas del archivo:", error);
    return {
      created: null,
      modified: null,
    };
  }
}


// Esta función mejorada extrae tanto el esquema como el nombre del objeto
function extractObjectInfoFromContent(fileContent, objectType) {
  // Normalizar el contenido para facilitar la búsqueda
  const content = fileContent.toString().toUpperCase();
  
  // Patrones a buscar según el tipo de objeto
  // Capturamos dos grupos: (esquema).(nombre_objeto)
  let patterns = [
    new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+${objectType}\\s+(\\w+)\\."?([\\w_]+)"?`, 'i'),
    new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+${objectType}\\s+(\\w+)\\.(\\w+)`, 'i'),
    new RegExp(`CREATE\\s+${objectType}\\s+(\\w+)\\."?([\\w_]+)"?`, 'i'),
    new RegExp(`CREATE\\s+${objectType}\\s+(\\w+)\\.(\\w+)`, 'i'),
    new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+${objectType}\\s+([\\w_]+)`, 'i'),
    new RegExp(`CREATE\\s+${objectType}\\s+([\\w_]+)`, 'i'),
    new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+${objectType}\\s+([\\w$#]+)`, 'i')
  ];
  
  // También para casos de PACKAGE BODY
  if (objectType === 'PACKAGE') {
    patterns.push(new RegExp('CREATE\\s+OR\\s+REPLACE\\s+PACKAGE\\s+BODY\\s+(\\w+)\\."?([\\w_]+)"?', 'i'));
    patterns.push(new RegExp('CREATE\\s+OR\\s+REPLACE\\s+PACKAGE\\s+BODY\\s+(\\w+)\\.(\\w+)', 'i'));
    patterns.push(new RegExp('CREATE\\s+PACKAGE\\s+BODY\\s+(\\w+)\\."?([\\w_]+)"?', 'i'));
    patterns.push(new RegExp('CREATE\\s+PACKAGE\\s+BODY\\s+(\\w+)\\.(\\w+)', 'i'));
    patterns.push(new RegExp('CREATE\\s+OR\\s+REPLACE\\s+PACKAGE\\s+BODY\\s+([\\w$#]+)', 'i'));
  }
  console.log(`[extract] Buscando en contenido para tipo: ${objectType}`);
  console.log("[extract] Contenido parcial:", content.slice(0, 300)); // primeros 300 caracteres
  // Probar cada patrón
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      if (match[2]) {
        return {
          schema: match[1],
          objectName: match[2]
        };
      } else if (match[1]) {
        return {
          schema: null,
          objectName: match[1]
        };
      }}}}

function extractSchemaAndName(fileName) {
  // Eliminar la extensión
  const baseName = path.basename(fileName, path.extname(fileName));

  // Patrón común: ESQUEMA_NOMBREOBJETO o ESQUEMA.NOMBREOBJETO
  const parts = baseName.split(/[_.]/);

  if (parts.length >= 2) {
    // Asumimos que el primer componente es el esquema
    return {
      schema: parts[0].toUpperCase(),
      objectName: parts.slice(1).join("_").toUpperCase(),
    };
  } else {
    // Si no podemos separar, usamos el nombre completo
    return {
      schema: null,
      objectName: baseName.toUpperCase(),
    };
  }
}
// Array para almacenar los archivos encontrados
let filesFound = [];

// Función para mostrar/ocultar el indicador de carga
function toggleLoader(elementId, show) {
  document.getElementById(elementId).style.display = show ? "block" : "none";
}

// Función para mostrar notificación en el modal
function showModalNotification(message, isError = false) {
  modalNotification.textContent = message;
  modalNotification.className = `notification ${isError ? "error" : "success"}`;
  modalNotification.style.display = "block";

  // Ocultar la notificación después de 5 segundos
  setTimeout(() => {
    modalNotification.style.display = "none";
  }, 7000);
}

// Función para explorar carpetas
browseButton.addEventListener("click", () => {
  ipcRenderer.send("open-folder-dialog");
});

// Recibir la ruta de la carpeta seleccionada
ipcRenderer.on("selected-folder", (event, folderPath) => {
  if (folderPath) {
    folderPathInput.value = folderPath;
  }
});

// Función para escanear archivos
scanButton.addEventListener("click", () => {
  const folderPath = folderPathInput.value.trim();

  if (!folderPath) {
    alert("Por favor, seleccione una carpeta para escanear.");
    return;
  }

  // Mostrar el indicador de carga
  toggleLoader("batchLoader", true);

  // Limpiar la lista de archivos previa
  fileListContainer.innerHTML = "";
  emptyMessage.style.display = "none";
  filesFound = [];

  // Enviar solicitud al proceso principal para escanear la carpeta
  ipcRenderer.send("scan-folder", {
    folderPath,
    extensions: [".pck", ".fnc", ".prc"],
  });
});

// Procesar los resultados del escaneo
ipcRenderer.on("scan-results", (event, files) => {
  // Ocultar el indicador de carga
  toggleLoader("batchLoader", false);

  // Guardar los archivos encontrados
  filesFound = files.map((file) => {
    const extension = path.extname(file).toLowerCase();
    let type = "Desconocido";

    switch (extension) {
      case ".pck":
        type = "PACKAGE";
        break;
      case ".fnc":
        type = "FUNCTION";
        break;
      case ".prc":
        type = "PROCEDURE";
        break;
    }

    const { schema, objectName } = extractSchemaAndName(path.basename(file));
    const fileDates = getFileDates(file);

    return {
      path: file,
      name: path.basename(file),
      schema: schema,
      objectName: objectName,
      type: type,
      extension: extension,
      created: fileDates.created, // Añadir esta línea
      modified: fileDates.modified, // Añadir esta línea
    };
  });

  // Mostrar los archivos
  displayFiles(filesFound);
});

// Función para mostrar los archivos en la tabla
function displayFiles(files) {
  fileListContainer.innerHTML = "";

  if (files.length === 0) {
    emptyMessage.style.display = "block";
    return;
  }

  emptyMessage.style.display = "none";

  files.forEach((file) => {
    const row = document.createElement("tr");

    // Columna de nombre
    const nameCell = document.createElement("td");
    nameCell.textContent = file.name;
    row.appendChild(nameCell);

    // Columna de tipo
    const typeCell = document.createElement("td");
    typeCell.textContent = file.type;
    row.appendChild(typeCell);

    // Columna de acciones
    const actionCell = document.createElement("td");
    const compareButton = document.createElement("button");
    compareButton.textContent = "Comparar";
    compareButton.className = "compare-button";
    compareButton.dataset.filepath = file.path;
    compareButton.dataset.objectType = file.type;
    compareButton.dataset.objectName = path.basename(
      file.name,
      path.extname(file.name)
    );

    // Columna de fecha de creación
    const createdCell = document.createElement("td");
    createdCell.textContent = formatDate(file.created);
    createdCell.className = "date-cell";
    row.appendChild(createdCell);

    // Columna de fecha de modificación
    const modifiedCell = document.createElement("td");
    modifiedCell.textContent = formatDate(file.modified);
    modifiedCell.className = "date-cell";
    row.appendChild(modifiedCell);

    compareButton.addEventListener("click", handleCompareClick);

    actionCell.appendChild(compareButton);
    row.appendChild(actionCell);

    fileListContainer.appendChild(row);
  });
}

// Función para manejar la búsqueda de archivos
searchInput.addEventListener("input", filterFiles);

// Función para manejar el filtrado por tipo de archivo
fileTypeFilters.forEach((filter) => {
  filter.addEventListener("change", filterFiles);
});

// Función para filtrar archivos
function filterFiles() {
  const searchTerm = searchInput.value.toLowerCase();
  const activeExtensions = Array.from(fileTypeFilters)
    .filter((filter) => filter.checked)
    .map((filter) => filter.value);

  const filteredFiles = filesFound.filter((file) => {
    const matchesSearch = file.name.toLowerCase().includes(searchTerm);
    const matchesExtension = activeExtensions.includes(file.extension);

    return matchesSearch && matchesExtension;
  });

  displayFiles(filteredFiles);
}

// Función para comparar código al hacer clic en el botón
async function handleCompareClick(event) {
  console.log("Botón Comparar clickeado");

  const button = event.currentTarget;
  console.log("Dataset del botón:", button.dataset);

  const filePath = button.dataset.filepath;
  const objectType = button.dataset.objectType;
  const objectName = button.dataset.objectName;

  console.log(
    `Datos: Ruta=${filePath}, Tipo=${objectType}, Nombre=${objectName}`
  );

  // Ya no verificamos el esquema aquí, lo extraeremos del contenido del archivo

  // Mostrar el modal
  compareModal.style.display = "block";
  modalTitle.textContent = path.basename(filePath);

  // Limpiar contenidos previos
  modalDbCode.innerHTML = "";
  modalFileCode.innerHTML = "";
  modalResultSummary.textContent = "";
  modalNotification.style.display = "none";

  // Mostrar loader
  toggleLoader("modalLoader", true);

  try {
    console.log("Enviando solicitud para leer archivo:", filePath);
    // Leer el contenido del archivo
    ipcRenderer.send("read-file", filePath);
  } catch (error) {
    console.error("Error al intentar leer el archivo:", error);
    toggleLoader("modalLoader", false);
    showModalNotification(`Error al leer el archivo: ${error.message}`, true);
  }
}

// Modificar la función que recibe el contenido del archivo
ipcRenderer.on("file-content", async (event, fileContent) => {
  if (!fileContent) {
    toggleLoader("modalLoader", false);
    showModalNotification("Error al leer el archivo o archivo vacío", true);
    return;
  }

  const button = document.querySelector(".compare-button:focus") || document.activeElement;
  if (!button || !button.classList.contains("compare-button")) {
    console.log("No se encontró un botón de comparación activo");
    return;
  }

  const objectType = button.dataset.objectType;
  const filePath = button.dataset.filepath;

  // Extraer del contenido
  let { schema, objectName } = extractObjectInfoFromContent(fileContent, objectType);

  if (!objectName) {
    toggleLoader("modalLoader", false);
    showModalNotification(
      `No se pudo detectar el nombre del objeto en el contenido del archivo. Verifica que el archivo contiene una declaración válida con formato: CREATE OR REPLACE ${objectType} [ESQUEMA.]NOMBRE`,
      true
    );
    return;
  }

  // Si no se detectó el esquema, intentar obtenerlo desde la base de datos
  if (!schema) {
    console.log("[batch-compare] Esquema no detectado en archivo. Buscando en DB...");
    try {
      const owner = await ipcRenderer.invoke("fetch-owner-from-db", objectName, objectType);
      if (owner) {
        console.log(`[batch-compare] Owner encontrado: ${owner}`);
        schema = owner;
      } else {
        console.warn(`[batch-compare] No se encontró el objeto ${objectName} en la DB.`);
        const currentDatabase = await ipcRenderer.invoke("get-database-name")
        toggleLoader("modalLoader", false);
        showModalNotification(`No se encontró el esquema del objeto '${objectName}' en la base de datos '${currentDatabase}'. Revisar su existencia.`, true);
        return;
      }
    } catch (err) {
      toggleLoader("modalLoader", false);
      showModalNotification(`Error al consultar el esquema desde la base de datos: ${err.message}`, true);
      return;
    }
  }

  // Continuar con la comparación si todo está bien
  console.log(`Información final: Esquema=${schema}, Nombre=${objectName}`);
  ipcRenderer.send("compare-code", {
    fileContent,
    schema,
    objectType,
    objectName,
    filePath
  });
});

// Recibir y mostrar resultado de comparación
ipcRenderer.on("compare-response", (event, response) => {
  // Ocultar el indicador de carga
  toggleLoader("modalLoader", false);

  try {
    // Verificar si la respuesta es un error
    if (typeof response === "string" && response.startsWith("Error")) {
      showModalNotification(response, true);
      return;
    }

    // Parsear la respuesta
    let dbCode,
      fileContent,
      differences,
      options = {};

    try {
      const parsedResponse = JSON.parse(response);
      dbCode = parsedResponse.dbCode;
      fileContent = parsedResponse.fileContent;
      differences = parsedResponse.differences;

      // Extraer información adicional si está disponible
      if ("specCodePresent" in parsedResponse) {
        options.specCodePresent = parsedResponse.specCodePresent;
      }
      if ("bodyCodePresent" in parsedResponse) {
        options.bodyCodePresent = parsedResponse.bodyCodePresent;
      }
      // Al recibir la respuesta, extraer las fechas
      if ('objectDates' in parsedResponse) {
        options.objectDates = parsedResponse.objectDates;
      }
      if ('fileDates' in parsedResponse) {
        options.fileDates = parsedResponse.fileDates;
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
    console.error("Error al procesar la respuesta:", error);
    showModalNotification(
      "Error al procesar la respuesta: " + error.message,
      true
    );
  }
});

// Función para mostrar la comparación en el modal
function displayModalComparison(
  dbCode,
  fileContent,
  differences,
  options = {}
) {
  modalDbCode.innerHTML = "";
  modalFileCode.innerHTML = "";

  const existingPackageInfo = document.querySelectorAll(".package-info");
  existingPackageInfo.forEach((info) => info.remove());

  let hasDifferences = differences.some((part) => part.added || part.removed);
  modalResultSummary.innerHTML = hasDifferences
    ? '<span style="vertical-align: middle;">📌 Se encontraron diferencias entre los códigos.</span>'
    : '<span style="vertical-align: middle;">✅ Los archivos son completamente iguales.</span>';

  if (!hasDifferences)
    showModalNotification("Los archivos son completamente iguales.");

  if (options.objectDates || options.fileDates) {
    displayModalDates(options.objectDates, options.fileDates);
  }

  if (options.specCodePresent || options.bodyCodePresent) {
    let packageInfoText = "";
    if (options.specCodePresent && options.bodyCodePresent)
      packageInfoText = "El objeto contiene tanto PACKAGE como PACKAGE BODY.";
    else if (options.specCodePresent)
      packageInfoText = "El objeto contiene solo PACKAGE (sin BODY).";
    else if (options.bodyCodePresent)
      packageInfoText =
        "El objeto contiene solo PACKAGE BODY (sin especificación).";
    if (packageInfoText) {
      const infoElement = document.createElement("div");
      infoElement.className = "package-info";
      infoElement.textContent = packageInfoText;
      modalResultSummary.parentNode.insertBefore(
        infoElement,
        modalResultSummary.nextSibling
      );
    }
  }

  let dbLines = [];
  let fileLines = [];

  differences.forEach((part) => {
    // Manejo especial para saltos de línea solos
    if (part.value === "\n") {
      if (part.removed) {
        dbLines.push(
          '<span class="removed diff-line empty-line"><span class="diff-marker">-</span> </span>'
        );
      } else if (part.added) {
        fileLines.push(
          '<span class="added diff-line empty-line"><span class="diff-marker">+</span> </span>'
        );
        dbLines.push('<span class="spacer diff-line empty-line"> </span>');
      }
      return;
    }

    const lines = part.value.split("\n").filter((line) => line !== "");
    lines.forEach((line, index) => {
      const lineHtml =
        line.replace(/\s/g, (match) =>
          match === " " ? " " : match === "\t" ? "    " : match
        ) || " ";
      const isLastLine = index === lines.length - 1;
      const needsLineBreak =
        !isLastLine || (part.value.endsWith("\n") && !isLastLine);

      if (part.added) {
        fileLines.push(
          `<span class="added diff-line"><span class="diff-marker">+</span>${lineHtml}</span>${
            needsLineBreak ? "\n" : ""
          }`
        );
        if (index === 0)
          dbLines.push('<span class="spacer diff-line"> </span>');
      } else if (part.removed) {
        dbLines.push(
          `<span class="removed diff-line"><span class="diff-marker">-</span>${lineHtml}</span>${
            needsLineBreak ? "\n" : ""
          }`
        );
        if (index === 0)
          fileLines.push('<span class="spacer diff-line"> </span>');
      } else {
        dbLines.push(
          `<span class="unchanged diff-line">${lineHtml}</span>${
            needsLineBreak ? "\n" : ""
          }`
        );
        fileLines.push(
          `<span class="unchanged diff-line">${lineHtml}</span>${
            needsLineBreak ? "\n" : ""
          }`
        );
      }
    });
  });

  // Asegurar que cada línea esté separada por un salto de línea real
  modalDbCode.innerHTML = dbLines.join("\n");
  modalFileCode.innerHTML = fileLines.join("\n");
  synchronizeModalScroll();
}

// Función para sincronizar el scroll entre los paneles del modal
function synchronizeModalScroll() {
  modalDbCode.addEventListener("scroll", () => {
    modalFileCode.scrollTop = modalDbCode.scrollTop;
    modalFileCode.scrollLeft = modalDbCode.scrollLeft;
  });

  modalFileCode.addEventListener("scroll", () => {
    modalDbCode.scrollTop = modalFileCode.scrollTop;
    modalDbCode.scrollLeft = modalFileCode.scrollLeft;
  });
}

// Filtrar para mostrar solo diferencias
modalShowOnlyDiff.addEventListener("change", function () {
  const showOnlyDiff = this.checked;
  const unchangedElements = document.querySelectorAll(
    "#modal-db-code .unchanged, #modal-file-code .unchanged"
  );

  unchangedElements.forEach((element) => {
    // Comprobamos si el elemento tiene contenido
    const hasText = element.textContent.trim() !== "";

    // Solo ocultamos elementos que tienen contenido
    if (hasText) {
      element.style.display = showOnlyDiff ? "none" : "block";
    }
  });
});

// Cerrar el modal
closeModal.addEventListener("click", () => {
  compareModal.style.display = "none";
});

// También cerrar el modal al hacer clic fuera del contenido
window.addEventListener("click", (event) => {
  if (event.target === compareModal) {
    compareModal.style.display = "none";
  }
});

// Evento para escuchar cuando se presiona la tecla Escape
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && compareModal.style.display === "block") {
    compareModal.style.display = "none";
  }
});
