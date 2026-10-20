// Variáveis Globais de Estado
let supabaseClient = null;
let documents = [];

// Inicialização da Aplicação ao carregar a página
document.addEventListener("DOMContentLoaded", () => {
    initSupabase();
    loadDocuments();
});

// 1. Inicializar Supabase através do LocalStorage
function initSupabase() {
    const url = localStorage.getItem("DOC_SUPABASE_URL");
    const key = localStorage.getItem("DOC_SUPABASE_KEY");

    if (url && key && window.supabase) {
        try {
            supabaseClient = window.supabase.createClient(url, key);
            document.getElementById("connectionAlert").classList.add("hidden");
            if (document.getElementById("supabaseUrlInput")) {
                document.getElementById("supabaseUrlInput").value = url;
                document.getElementById("supabaseKeyInput").value = key;
            }
        } catch (e) {
            console.error("Erro ao conectar com Supabase:", e);
        }
    } else {
        document.getElementById("connectionAlert").classList.remove("hidden");
    }
}

// 2. Salvar credenciais de configuração
function saveSupabaseConfig() {
    const url = document.getElementById("supabaseUrlInput").value.trim();
    const key = document.getElementById("supabaseKeyInput").value.trim();

    if (!url || !key) {
        showToast("Preencha ambos os campos para salvar!", "warning");
        return;
    }

    localStorage.setItem("DOC_SUPABASE_URL", url);
    localStorage.setItem("DOC_SUPABASE_KEY", key);
    
    initSupabase();
    toggleConfigModal();
    showToast("Supabase conectado com sucesso!", "success");
    loadDocuments();
}

// 3. Carregar Documentos (do Supabase ou do LocalStorage como Fallback)
async function loadDocuments() {
    if (supabaseClient) {
        try {
            const { data, error } = await supabaseClient
                .from('documents')
                .select('*')
                .order('due_date', { ascending: true });

            if (error) throw error;
            documents = data.map(doc => ({
                id: doc.id,
                title: doc.title,
                category: doc.category,
                dueDate: doc.due_date,
                notes: doc.notes,
                fileUrl: doc.file_url
            }));
        } catch (err) {
            console.error("Erro na busca no Supabase:", err);
            showToast("Falha ao buscar no Supabase. Usando armazenamento local.", "warning");
            fallbackLocalLoad();
        }
    } else {
        fallbackLocalLoad();
    }

    renderDocuments();
}

function fallbackLocalLoad() {
    const saved = localStorage.getItem("LOCAL_DOCUMENTS");
    documents = saved ? JSON.parse(saved) : [];
}

function fallbackLocalSave() {
    localStorage.setItem("LOCAL_DOCUMENTS", JSON.stringify(documents));
}

// 4. Salvar ou Atualizar Documento
async function handleFormSubmit(e) {
    e.preventDefault();
    
    const id = document.getElementById("docId").value;
    const title = document.getElementById("docTitle").value.trim();
    const category = document.getElementById("docCategory").value;
    const dueDate = document.getElementById("docDueDate").value;
    const notes = document.getElementById("docNotes").value.trim();
    const fileInput = document.getElementById("docFile");
    const file = fileInput.files[0];

    const saveBtn = document.getElementById("saveBtn");
    saveBtn.disabled = true;
    saveBtn.innerText = "Processando...";

    try {
        let fileUrl = "";

        // Upload de arquivo
        if (file) {
            if (supabaseClient) {
                const fileExt = file.name.split('.').pop();
                const fileName = `${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`;
                
                const { data: uploadData, error: uploadError } = await supabaseClient.storage
                    .from('doc-files')
                    .upload(fileName, file);

                if (uploadError) throw uploadError;

                const { data: publicUrlData } = supabaseClient.storage
                    .from('doc-files')
                    .getPublicUrl(fileName);

                fileUrl = publicUrlData.publicUrl;
            } else {
                // Simulação local simples caso não haja Supabase
                fileUrl = URL.createObjectURL(file);
            }
        }

        if (supabaseClient) {
            const payload = {
                title,
                category,
                due_date: dueDate,
                notes,
                ...(fileUrl && { file_url: fileUrl })
            };

            if (id) {
                const { error } = await supabaseClient.from('documents').update(payload).eq('id', id);
                if (error) throw error;
            } else {
                const { error } = await supabaseClient.from('documents').insert([payload]);
                if (error) throw error;
            }
        } else {
            // Salvar Localmente
            if (id) {
                const index = documents.findIndex(d => d.id === id);
                if (index !== -1) {
                    documents[index] = { 
                        ...documents[index], 
                        title, 
                        category, 
                        dueDate, 
                        notes, 
                        fileUrl: fileUrl || documents[index].fileUrl 
                    };
                }
            } else {
                documents.push({
                    id: crypto.randomUUID(),
                    title,
                    category,
                    dueDate,
                    notes,
                    fileUrl
                });
            }
            fallbackLocalSave();
        }

        showToast(id ? "Documento atualizado!" : "Documento cadastrado com sucesso!", "success");
        closeDocModal();
        loadDocuments();

    } catch (err) {
        console.error("Erro ao salvar:", err);
        showToast("Erro ao salvar o documento. Verifique a configuração.", "error");
    } finally {
        saveBtn.disabled = false;
        saveBtn.innerText = "Salvar Documento";
    }
}

// 5. Excluir Documento
async function deleteDocument(id) {
    if (!confirm("Tem certeza que deseja excluir este documento?")) return;

    if (supabaseClient) {
        try {
            const { error } = await supabaseClient.from('documents').delete().eq('id', id);
            if (error) throw error;
            showToast("Documento excluído!", "success");
            loadDocuments();
        } catch (err) {
            console.error("Erro ao excluir:", err);
            showToast("Erro ao excluir documento.", "error");
        }
    } else {
        documents = documents.filter(d => d.id !== id);
        fallbackLocalSave();
        showToast("Documento excluído localmente!", "success");
        renderDocuments();
    }
}

// 6. Renderização na Tela
function renderDocuments() {
    const tableBody = document.getElementById("documentsTable");
    const emptyState = document.getElementById("emptyState");
    const search = document.getElementById("searchInput").value.toLowerCase();
    const categoryFilter = document.getElementById("categoryFilter").value;

    // Filtragem
    const filtered = documents.filter(doc => {
        const matchesSearch = doc.title.toLowerCase().includes(search) || (doc.notes && doc.notes.toLowerCase().includes(search));
        const matchesCategory = categoryFilter === "all" || doc.category === categoryFilter;
        return matchesSearch && matchesCategory;
    });

    // Atualização de Métricas
    updateStats();

    if (filtered.length === 0) {
        tableBody.innerHTML = "";
        emptyState.classList.remove("hidden");
        return;
    }

    emptyState.classList.add("hidden");
    
    tableBody.innerHTML = filtered.map(doc => {
        const statusInfo = calculateStatus(doc.dueDate);
        const formattedDate = new Date(doc.dueDate + "T00:00:00").toLocaleDateString('pt-BR');

        return `
            <tr class="hover:bg-slate-50/80 transition">
                <td class="py-4 px-6 font-medium text-slate-800">
                    <div>${escapeHtml(doc.title)}</div>
                    ${doc.notes ? `<div class="text-xs text-slate-400 font-normal mt-0.5 truncate max-w-xs">${escapeHtml(doc.notes)}</div>` : ''}
                </td>
                <td class="py-4 px-6 text-slate-600">
                    <span class="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium bg-slate-100 text-slate-700">
                        ${doc.category}
                    </span>
                </td>
                <td class="py-4 px-6 text-slate-600 font-mono text-xs">
                    ${formattedDate}
                </td>
                <td class="py-4 px-6">
                    <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold ${statusInfo.badgeClass}">
                        <i class="fa-solid ${statusInfo.icon} text-[10px]"></i>
                        ${statusInfo.label}
                    </span>
                </td>
                <td class="py-4 px-6">
                    ${doc.fileUrl ? `
                        <a href="${doc.fileUrl}" target="_blank" class="inline-flex items-center gap-1 text-xs text-indigo-600 font-medium hover:underline">
                            <i class="fa-solid fa-paperclip"></i> Visualizar
                        </a>
                    ` : '<span class="text-xs text-slate-300">Sem anexo</span>'}
                </td>
                <td class="py-4 px-6 text-right space-x-2">
                    <button onclick="editDocument('${doc.id}')" class="text-slate-400 hover:text-indigo-600 transition p-1" title="Editar">
                        <i class="fa-solid fa-pen-to-square"></i>
                    </button>
                    <button onclick="deleteDocument('${doc.id}')" class="text-slate-400 hover:text-rose-600 transition p-1" title="Excluir">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </td>
            </tr>
        `;
    }).join('');
}

// 7. Cálculo do Status do Vencimento
function calculateStatus(dueDateStr) {
    const today = new Date();
    today.setHours(0,0,0,0);
    
    const dueDate = new Date(dueDateStr + "T00:00:00");
    const diffTime = dueDate - today;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays < 0) {
        return {
            label: `Vencido (${Math.abs(diffDays)}d)`,
            badgeClass: "bg-rose-100 text-rose-700 border border-rose-200",
            icon: "fa-circle-xmark",
            type: "expired"
        };
    } else if (diffDays <= 30) {
        return {
            label: diffDays === 0 ? "Vence Hoje" : `Vence em ${diffDays}d`,
            badgeClass: "bg-amber-100 text-amber-800 border border-amber-200",
            icon: "fa-clock",
            type: "warning"
        };
    } else {
        return {
            label: "Em Dia",
            badgeClass: "bg-emerald-100 text-emerald-800 border border-emerald-200",
            icon: "fa-circle-check",
            type: "ok"
        };
    }
}

// 8. Métricas do Topo
function updateStats() {
    let total = documents.length;
    let ok = 0;
    let warning = 0;
    let expired = 0;

    documents.forEach(doc => {
        const status = calculateStatus(doc.dueDate);
        if (status.type === 'ok') ok++;
        if (status.type === 'warning') warning++;
        if (status.type === 'expired') expired++;
    });

    document.getElementById("statTotal").innerText = total;
    document.getElementById("statOk").innerText = ok;
    document.getElementById("statWarning").innerText = warning;
    document.getElementById("statExpired").innerText = expired;
}

// 9. Modais e Utilitários
function openDocModal() {
    document.getElementById("docForm").reset();
    document.getElementById("docId").value = "";
    document.getElementById("modalTitle").innerText = "Novo Documento";
    document.getElementById("docModal").classList.remove("hidden");
}

function closeDocModal() {
    document.getElementById("docModal").classList.add("hidden");
}

function editDocument(id) {
    const doc = documents.find(d => d.id === id);
    if (!doc) return;

    document.getElementById("docId").value = doc.id;
    document.getElementById("docTitle").value = doc.title;
    document.getElementById("docCategory").value = doc.category;
    document.getElementById("docDueDate").value = doc.dueDate;
    document.getElementById("docNotes").value = doc.notes || "";
    
    document.getElementById("modalTitle").innerText = "Editar Documento";
    document.getElementById("docModal").classList.remove("hidden");
}

function toggleConfigModal() {
    const modal = document.getElementById("configModal");
    modal.classList.contains("hidden") ? modal.classList.remove("hidden") : modal.classList.add("hidden");
}

function showToast(message, type = "success") {
    const toast = document.getElementById("toast");
    const msgEl = document.getElementById("toastMessage");
    const iconEl = document.getElementById("toastIcon");

    msgEl.innerText = message;

    if (type === "success") {
        iconEl.className = "fa-solid fa-circle-check text-emerald-400 text-base";
    } else if (type === "warning") {
        iconEl.className = "fa-solid fa-triangle-exclamation text-amber-400 text-base";
    } else {
        iconEl.className = "fa-solid fa-circle-exclamation text-rose-400 text-base";
    }

    toast.classList.remove("translate-y-20", "opacity-0");
    setTimeout(() => {
        toast.classList.add("translate-y-20", "opacity-0");
    }, 3500);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.innerText = text;
    return div.innerHTML;
}