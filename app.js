// ===== Configuração =====
const SUPABASE_URL = "https://hipsweaqpqoxmffwvxsr.supabase.co";
const SUPABASE_KEY = "sb_publishable_zONl2i0QwkMPcQeyAxeYug_084e4zuJ"; // chave publishable (sb_publishable_...) ou anon (eyJ...)

const BUCKET = "doc-files";
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = new Map([
    ["application/pdf", "pdf"],
    ["image/png", "png"],
    ["image/jpeg", "jpg"],
    ["image/webp", "webp"]
]);
const CATEGORIES = ["Veículos", "Imóveis", "Pessoal", "Financeiro", "Outros"];
const SIGNED_URL_TTL = 60 * 60; // link do anexo válido por 1 hora

// ===== Estado global =====
let supabaseClient = null;
let currentUser = null; // { id, username, isAdmin, canCreate, canEdit, canDelete }
let documents = [];
let companies = [];        // todas as empresas (ativas e inativas)
let editingCompanyId = "";
let toastTimer = null;

// ===== Inicialização =====
document.addEventListener("DOMContentLoaded", async () => {
    document.getElementById("loginForm").addEventListener("submit", handleLogin);
    document.getElementById("documentsTable").addEventListener("click", handleTableClick);
    document.getElementById("companyTable").addEventListener("click", handleCompanyTableClick);
    document.getElementById("companyForm").addEventListener("submit", saveCompany);

    document.getElementById("docFile").addEventListener("change", (e) => {
        const error = validateFile(e.target.files[0]);
        if (error) {
            showToast(error, "warning");
            e.target.value = "";
        }
    });

    initSupabase();
    await restoreSession();
});

// ===== Utilitários de segurança e formatação =====
function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    }[ch]));
}

// Aceita apenas links https ou blob
function safeUrl(url) {
    if (!url) return "";
    try {
        const parsed = new URL(url, window.location.href);
        return ["https:", "blob:"].includes(parsed.protocol) ? escapeHtml(parsed.href) : "";
    } catch {
        return "";
    }
}

// Detecta chave service_role (JWT com role = service_role, ou formato sb_secret_)
function isServiceRoleKey(key) {
    if (key.startsWith("sb_secret_")) return true;
    const parts = key.split(".");
    if (parts.length !== 3) return false;
    try {
        let base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        base64 = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
        const payload = JSON.parse(atob(base64));
        return payload.role === "service_role";
    } catch {
        return false;
    }
}

function validateFile(file) {
    if (!file) return null;
    if (!ALLOWED_TYPES.has(file.type)) return "Envie apenas PDF, PNG, JPG ou WebP.";
    if (file.size > MAX_FILE_SIZE) return "O arquivo deve ter no máximo 5MB.";
    return null;
}

function formatCnpj(digits) {
    const d = String(digits || "").replace(/\D/g, "");
    if (d.length !== 14) return d;
    return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
}

// ===== Conexão com o Supabase =====
function initSupabase() {
    supabaseClient = null;

    if (window.supabase && SUPABASE_KEY !== "COLE_AQUI" && !isServiceRoleKey(SUPABASE_KEY)) {
        supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
        supabaseClient.auth.onAuthStateChange((event) => {
            if (event === "SIGNED_OUT") showLogin();
        });
    }

    return !!supabaseClient;
}

// ===== Login e sessão =====
async function restoreSession() {
    if (!supabaseClient) {
        showLogin();
        showLoginError("Sistema não configurado. Informe a chave no app.js.");
        return;
    }

    const { data } = await supabaseClient.auth.getSession();
    if (data.session) {
        await startSession(data.session.user.id);
    } else {
        showLogin();
    }
}

async function handleLogin(e) {
    e.preventDefault();

    const loginBtn = document.getElementById("loginBtn");
    const email = document.getElementById("loginUser").value.trim();
    const password = document.getElementById("loginPassword").value;

    hideLoginError();

    if (!supabaseClient) {
        showLoginError("Sistema não configurado. Informe a chave no app.js.");
        return;
    }
    if (!email.includes("@")) {
        showLoginError("Informe o e-mail cadastrado.");
        return;
    }

    loginBtn.disabled = true;
    loginBtn.innerText = "Entrando...";

    try {
        const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });

        if (error) {
            showLoginError("E-mail ou senha inválidos.");
            return;
        }

        const ok = await startSession(data.user.id);
        if (!ok) {
            showLoginError("Usuário sem perfil ativo. Fale com o administrador.");
        } else {
            document.getElementById("loginPassword").value = "";
        }
    } catch (err) {
        console.error("Erro no login:", err);
        showLoginError("Não foi possível entrar. Verifique a conexão.");
    } finally {
        loginBtn.disabled = false;
        loginBtn.innerText = "Entrar";
    }
}

async function startSession(userId) {
    const profile = await loadProfile(userId);

    if (!profile) {
        await supabaseClient.auth.signOut();
        showLogin();
        return false;
    }

    currentUser = profile;
    showApp();
    await loadCompanies();
    await loadDocuments();
    return true;
}

async function loadProfile(userId) {
    const { data, error } = await supabaseClient
        .from("profiles")
        .select("username, is_admin, can_create, can_edit, can_delete, active")
        .eq("id", userId)
        .maybeSingle();

    if (error) {
        console.error("Erro ao buscar perfil:", error);
        return null;
    }
    if (!data || !data.active) return null;

    return {
        id: userId,
        username: data.username,
        isAdmin: data.is_admin,
        canCreate: data.is_admin || data.can_create,
        canEdit: data.is_admin || data.can_edit,
        canDelete: data.is_admin || data.can_delete
    };
}

async function logout() {
    if (supabaseClient) await supabaseClient.auth.signOut();
    showLogin();
    showToast("Sessão encerrada.", "success");
}

function showLogin() {
    currentUser = null;
    documents = [];
    companies = [];
    document.getElementById("documentsTable").innerHTML = "";
    document.getElementById("companyTable").innerHTML = "";
    document.getElementById("loginScreen").classList.remove("hidden");
    document.getElementById("appScreen").classList.add("hidden");
    document.getElementById("userInfo").classList.add("hidden");
    document.getElementById("logoutBtn").classList.add("hidden");
    document.getElementById("logoutBtn").classList.remove("flex");
    document.getElementById("btnNewDoc").classList.add("hidden");
    document.getElementById("btnNewDoc").classList.remove("flex");
    document.getElementById("btnCompanies").classList.add("hidden");
    document.getElementById("btnCompanies").classList.remove("flex");
}

function showApp() {
    document.getElementById("loginScreen").classList.add("hidden");
    document.getElementById("appScreen").classList.remove("hidden");

    const info = document.getElementById("userInfo");
    info.innerText = `${currentUser.username}${currentUser.isAdmin ? " (administrador)" : ""}`;
    info.classList.remove("hidden");

    const logoutBtn = document.getElementById("logoutBtn");
    logoutBtn.classList.remove("hidden");
    logoutBtn.classList.add("flex");

    const btnNew = document.getElementById("btnNewDoc");
    btnNew.classList.toggle("hidden", !currentUser.canCreate);
    btnNew.classList.toggle("flex", currentUser.canCreate);

    const btnCompanies = document.getElementById("btnCompanies");
    btnCompanies.classList.toggle("hidden", !currentUser.isAdmin);
    btnCompanies.classList.toggle("flex", currentUser.isAdmin);
}

function showLoginError(message) {
    const el = document.getElementById("loginError");
    el.innerText = message;
    el.classList.remove("hidden");
}

function hideLoginError() {
    document.getElementById("loginError").classList.add("hidden");
}

// ===== Empresas: carregamento e seletores =====
async function loadCompanies() {
    if (!supabaseClient || !currentUser) return;

    const { data, error } = await supabaseClient
        .from("companies")
        .select("id, name, cnpj, active")
        .order("name", { ascending: true });

    if (error) {
        console.error("Erro ao carregar empresas:", error);
        showToast("Não foi possível carregar as empresas.", "error");
        companies = [];
    } else {
        companies = data;
    }

    fillCompanyFilter();
    renderCompanyTable();
}

// Filtro da tela principal: todas as empresas, com ou sem inativas
function fillCompanyFilter() {
    const select = document.getElementById("companyFilter");
    const current = select.value || "all";

    select.innerHTML = `<option value="all">Todas as Empresas</option>` +
        companies.map((c) =>
            `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}${c.active ? "" : " (inativa)"}</option>`
        ).join("");

    select.value = [...select.options].some((o) => o.value === current) ? current : "all";
}

// Modal de documento: só empresas ativas, mais a empresa atual do documento se estiver inativa
function fillDocCompanySelect(selectedId = "") {
    const select = document.getElementById("docCompany");
    const options = companies.filter((c) => c.active || c.id === selectedId);

    select.innerHTML = `<option value="">Selecione a empresa</option>` +
        options.map((c) =>
            `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}${c.active ? "" : " (inativa)"}</option>`
        ).join("");

    select.value = selectedId || "";
}

// ===== Empresas: cadastro (somente administrador) =====
function openCompanyModal() {
    if (!currentUser?.isAdmin) {
        showToast("Apenas o administrador cadastra empresas.", "warning");
        return;
    }
    resetCompanyForm();
    renderCompanyTable();
    document.getElementById("companyModal").classList.remove("hidden");
}

function closeCompanyModal() {
    document.getElementById("companyModal").classList.add("hidden");
}

function resetCompanyForm() {
    document.getElementById("companyForm").reset();
    document.getElementById("companyId").value = "";
    editingCompanyId = "";
    document.getElementById("companySaveBtn").innerText = "Salvar Empresa";
}

function editCompany(id) {
    const company = companies.find((c) => c.id === id);
    if (!company) return;

    editingCompanyId = company.id;
    document.getElementById("companyId").value = company.id;
    document.getElementById("companyName").value = company.name;
    document.getElementById("companyCnpj").value = company.cnpj ? formatCnpj(company.cnpj) : "";
    document.getElementById("companyActive").checked = !!company.active;
    document.getElementById("companySaveBtn").innerText = "Atualizar Empresa";
    document.getElementById("companyName").focus();
}

async function saveCompany(e) {
    e.preventDefault();
    if (!currentUser?.isAdmin) {
        showToast("Apenas o administrador cadastra empresas.", "warning");
        return;
    }

    const name = document.getElementById("companyName").value.trim();
    const cnpjDigits = document.getElementById("companyCnpj").value.replace(/\D/g, "");
    const active = document.getElementById("companyActive").checked;

    if (!name) {
        showToast("Informe o nome da empresa.", "warning");
        return;
    }
    if (cnpjDigits && cnpjDigits.length !== 14) {
        showToast("O CNPJ deve ter 14 dígitos.", "warning");
        return;
    }

    const btn = document.getElementById("companySaveBtn");
    btn.disabled = true;

    const payload = { name, cnpj: cnpjDigits || null, active };

    try {
        if (editingCompanyId) {
            const { data, error } = await supabaseClient
                .from("companies")
                .update(payload)
                .eq("id", editingCompanyId)
                .select("id");
            if (error) throw error;
            if (!data.length) throw new Error("Nenhuma empresa foi alterada.");
            showToast("Empresa atualizada!", "success");
        } else {
            const { error } = await supabaseClient.from("companies").insert([payload]);
            if (error) throw error;
            showToast("Empresa cadastrada com sucesso!", "success");
        }

        resetCompanyForm();
        await loadCompanies();
        await loadDocuments();
    } catch (err) {
        console.error("Erro ao salvar empresa:", err);
        showToast(
            err.code === "23505"
                ? "Já existe uma empresa com esse nome."
                : "Erro ao salvar empresa. Verifique suas permissões.",
            "error"
        );
    } finally {
        btn.disabled = false;
    }
}

async function deleteCompany(id) {
    if (!currentUser?.isAdmin) return;
    if (!confirm("Tem certeza que deseja excluir esta empresa?")) return;

    try {
        const { data, error } = await supabaseClient
            .from("companies")
            .delete()
            .eq("id", id)
            .select("id");
        if (error) throw error;
        if (!data.length) throw new Error("Nenhuma empresa foi excluída.");

        showToast("Empresa excluída!", "success");
        await loadCompanies();
    } catch (err) {
        console.error("Erro ao excluir empresa:", err);
        showToast(
            err.code === "23503"
                ? "Esta empresa tem documentos vinculados. Desative-a em vez de excluir."
                : "Erro ao excluir empresa.",
            "error"
        );
    }
}

function renderCompanyTable() {
    const tbody = document.getElementById("companyTable");

    if (companies.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="py-6 text-center text-xs text-slate-400">Nenhuma empresa cadastrada.</td></tr>`;
        return;
    }

    tbody.innerHTML = companies.map((c) => `
        <tr class="hover:bg-slate-50/80 transition">
            <td class="py-3 px-4 font-medium text-slate-800">${escapeHtml(c.name)}</td>
            <td class="py-3 px-4 text-slate-600 font-mono text-xs">${c.cnpj ? escapeHtml(formatCnpj(c.cnpj)) : "-"}</td>
            <td class="py-3 px-4">
                <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${c.active ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-600"}">
                    ${c.active ? "Ativa" : "Inativa"}
                </span>
            </td>
            <td class="py-3 px-4 text-right space-x-2">
                <button type="button" data-company-action="edit" data-id="${escapeHtml(c.id)}" class="text-slate-400 hover:text-indigo-600 transition p-1" title="Editar" aria-label="Editar empresa">
                    <i class="fa-solid fa-pen-to-square" aria-hidden="true"></i>
                </button>
                <button type="button" data-company-action="delete" data-id="${escapeHtml(c.id)}" class="text-slate-400 hover:text-rose-600 transition p-1" title="Excluir" aria-label="Excluir empresa">
                    <i class="fa-solid fa-trash" aria-hidden="true"></i>
                </button>
            </td>
        </tr>`).join("");
}

function handleCompanyTableClick(e) {
    const btn = e.target.closest("button[data-company-action]");
    if (!btn) return;

    const id = btn.dataset.id;
    if (btn.dataset.companyAction === "edit") editCompany(id);
    if (btn.dataset.companyAction === "delete") deleteCompany(id);
}

// ===== Documentos: carregamento =====
async function loadDocuments() {
    if (!supabaseClient || !currentUser) return;

    try {
        const { data, error } = await supabaseClient
            .from("documents")
            .select("*, companies(name)")
            .order("due_date", { ascending: true });

        if (error) throw error;
        documents = await Promise.all(data.map(mapRemoteDocument));
    } catch (err) {
        console.error("Erro na busca no Supabase:", err);
        showToast("Falha ao buscar documentos. Verifique sua permissão.", "error");
        documents = [];
    }

    renderDocuments();
}

async function mapRemoteDocument(row) {
    return {
        id: row.id,
        title: row.title,
        companyId: row.company_id || "",
        companyName: row.companies?.name || "",
        category: row.category,
        dueDate: row.due_date,
        notes: row.notes || "",
        fileRef: row.file_url || "",
        fileUrl: await resolveFileUrl(row.file_url)
    };
}

// Gera link temporário para o arquivo privado; links antigos (http) são mantidos
async function resolveFileUrl(ref) {
    if (!ref) return "";
    if (/^https?:\/\//i.test(ref)) return ref;

    const { data, error } = await supabaseClient.storage
        .from(BUCKET)
        .createSignedUrl(ref, SIGNED_URL_TTL);

    if (error) {
        console.error("Erro ao gerar link do anexo:", error);
        return "";
    }
    return data.signedUrl;
}

// ===== Arquivos no Storage =====
async function uploadFile(file) {
    const ext = ALLOWED_TYPES.get(file.type);
    const path = `${crypto.randomUUID()}.${ext}`;

    const { error } = await supabaseClient.storage
        .from(BUCKET)
        .upload(path, file, { contentType: file.type, upsert: false });

    if (error) throw error;
    return path;
}

async function removeStoredFile(ref) {
    if (!supabaseClient || !ref || /^https?:\/\//i.test(ref)) return;

    const { error } = await supabaseClient.storage.from(BUCKET).remove([ref]);
    if (error) console.error("Erro ao remover arquivo do storage:", error);
}

// ===== Salvar / Atualizar documento =====
async function handleFormSubmit(e) {
    e.preventDefault();
    if (!currentUser) return;

    const id = document.getElementById("docId").value;
    const title = document.getElementById("docTitle").value.trim();
    const companyId = document.getElementById("docCompany").value;
    const category = document.getElementById("docCategory").value;
    const dueDate = document.getElementById("docDueDate").value;
    const notes = document.getElementById("docNotes").value.trim();
    const file = document.getElementById("docFile").files[0];

    if (id && !currentUser.canEdit) {
        showToast("Você não tem permissão para alterar documentos.", "warning");
        return;
    }
    if (!id && !currentUser.canCreate) {
        showToast("Você não tem permissão para cadastrar documentos.", "warning");
        return;
    }
    if (file && !currentUser.canCreate) {
        showToast("Você não tem permissão para enviar anexos.", "warning");
        return;
    }

    if (!companyId) {
        showToast("Selecione a empresa do documento.", "warning");
        return;
    }
    if (!title || !dueDate || !CATEGORIES.includes(category)) {
        showToast("Preencha os campos obrigatórios.", "warning");
        return;
    }

    const fileError = validateFile(file);
    if (fileError) {
        showToast(fileError, "warning");
        return;
    }

    const saveBtn = document.getElementById("saveBtn");
    saveBtn.disabled = true;
    saveBtn.innerText = "Processando...";

    let uploadedPath = null; // arquivo enviado nesta operação, para limpeza em caso de erro

    try {
        let fileRef; // undefined = mantém o anexo atual
        if (file) {
            uploadedPath = await uploadFile(file);
            fileRef = uploadedPath;
        }

        const payload = {
            title,
            company_id: companyId,
            category,
            due_date: dueDate,
            notes,
            ...(fileRef && { file_url: fileRef })
        };

        if (id) {
            const old = documents.find((d) => d.id === id);

            const { data, error } = await supabaseClient
                .from("documents")
                .update(payload)
                .eq("id", id)
                .select("id");
            if (error) throw error;
            if (!data.length) throw new Error("Nenhum registro foi alterado.");

            uploadedPath = null;

            if (fileRef && old?.fileRef) await removeStoredFile(old.fileRef);
        } else {
            const { error } = await supabaseClient.from("documents").insert([payload]);
            if (error) throw error;

            uploadedPath = null;
        }

        showToast(id ? "Documento atualizado!" : "Documento cadastrado com sucesso!", "success");
        closeDocModal();
        await loadDocuments();
    } catch (err) {
        console.error("Erro ao salvar:", err);
        if (uploadedPath) await removeStoredFile(uploadedPath);
        showToast("Erro ao salvar o documento. Verifique suas permissões.", "error");
    } finally {
        saveBtn.disabled = false;
        saveBtn.innerText = "Salvar Documento";
    }
}

// ===== Excluir documento =====
async function deleteDocument(id) {
    if (!currentUser?.canDelete) {
        showToast("Você não tem permissão para excluir documentos.", "warning");
        return;
    }
    if (!confirm("Tem certeza que deseja excluir este documento?")) return;

    const doc = documents.find((d) => d.id === id);

    try {
        const { data, error } = await supabaseClient
            .from("documents")
            .delete()
            .eq("id", id)
            .select("id");
        if (error) throw error;
        if (!data.length) throw new Error("Nenhum registro foi excluído.");

        if (doc?.fileRef) await removeStoredFile(doc.fileRef);

        showToast("Documento excluído!", "success");
        await loadDocuments();
    } catch (err) {
        console.error("Erro ao excluir:", err);
        showToast("Erro ao excluir documento. Verifique suas permissões.", "error");
    }
}

// Botões da tabela usam delegação de eventos
function handleTableClick(e) {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;

    const id = btn.dataset.id;
    if (btn.dataset.action === "edit") editDocument(id);
    if (btn.dataset.action === "delete") deleteDocument(id);
}

// ===== Renderização =====
function formatDate(dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    return isNaN(d) ? "-" : d.toLocaleDateString("pt-BR");
}

function renderDocuments() {
    const tableBody = document.getElementById("documentsTable");
    const emptyState = document.getElementById("emptyState");
    const search = document.getElementById("searchInput").value.toLowerCase();
    const companyFilter = document.getElementById("companyFilter").value;
    const categoryFilter = document.getElementById("categoryFilter").value;

    const filtered = documents.filter((doc) => {
        const title = (doc.title || "").toLowerCase();
        const notes = (doc.notes || "").toLowerCase();
        const matchesSearch = title.includes(search) || notes.includes(search);
        const matchesCompany = companyFilter === "all" || doc.companyId === companyFilter;
        const matchesCategory = categoryFilter === "all" || doc.category === categoryFilter;
        return matchesSearch && matchesCompany && matchesCategory;
    });

    updateStats();

    if (filtered.length === 0) {
        tableBody.innerHTML = "";
        emptyState.classList.remove("hidden");
        return;
    }

    emptyState.classList.add("hidden");

    tableBody.innerHTML = filtered.map((doc) => {
        const status = calculateStatus(doc.dueDate);
        const link = safeUrl(doc.fileUrl);
        const id = escapeHtml(doc.id);

        let attachment;
        if (link) {
            attachment = `
                <a href="${link}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-xs text-indigo-600 font-medium hover:underline">
                    <i class="fa-solid fa-paperclip" aria-hidden="true"></i> Visualizar
                </a>`;
        } else if (doc.fileRef) {
            attachment = `<span class="text-xs text-rose-400">Anexo indisponível</span>`;
        } else {
            attachment = `<span class="text-xs text-slate-300">Sem anexo</span>`;
        }

        // Botões conforme permissão do usuário logado (o banco também confere)
        let actions = "";
        if (currentUser?.canEdit) {
            actions += `
                <button type="button" data-action="edit" data-id="${id}" class="text-slate-400 hover:text-indigo-600 transition p-1" title="Editar" aria-label="Editar documento">
                    <i class="fa-solid fa-pen-to-square" aria-hidden="true"></i>
                </button>`;
        }
        if (currentUser?.canDelete) {
            actions += `
                <button type="button" data-action="delete" data-id="${id}" class="text-slate-400 hover:text-rose-600 transition p-1" title="Excluir" aria-label="Excluir documento">
                    <i class="fa-solid fa-trash" aria-hidden="true"></i>
                </button>`;
        }
        if (!actions) {
            actions = `<span class="text-xs text-slate-300">Somente consulta</span>`;
        }

        return `
            <tr class="hover:bg-slate-50/80 transition">
                <td class="py-4 px-6 font-medium text-slate-800">
                    <div>${escapeHtml(doc.title)}</div>
                    ${doc.notes ? `<div class="text-xs text-slate-400 font-normal mt-0.5 truncate max-w-xs">${escapeHtml(doc.notes)}</div>` : ""}
                </td>
                <td class="py-4 px-6 text-slate-600">${doc.companyName ? escapeHtml(doc.companyName) : '<span class="text-xs text-slate-300">Sem empresa</span>'}</td>
                <td class="py-4 px-6 text-slate-600">
                    <span class="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium bg-slate-100 text-slate-700">
                        ${escapeHtml(doc.category)}
                    </span>
                </td>
                <td class="py-4 px-6 text-slate-600 font-mono text-xs">${formatDate(doc.dueDate)}</td>
                <td class="py-4 px-6">
                    <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold ${status.badgeClass}">
                        <i class="fa-solid ${status.icon} text-[10px]" aria-hidden="true"></i>
                        ${escapeHtml(status.label)}
                    </span>
                </td>
                <td class="py-4 px-6">${attachment}</td>
                <td class="py-4 px-6 text-right space-x-2">${actions}</td>
            </tr>`;
    }).join("");
}

// ===== Status do vencimento =====
function calculateStatus(dueDateStr) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const dueDate = new Date(dueDateStr + "T00:00:00");
    const diffDays = Math.ceil((dueDate - today) / (1000 * 60 * 60 * 24));

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
    }
    return {
        label: "Em Dia",
        badgeClass: "bg-emerald-100 text-emerald-800 border border-emerald-200",
        icon: "fa-circle-check",
        type: "ok"
    };
}

function updateStats() {
    let ok = 0;
    let warning = 0;
    let expired = 0;

    documents.forEach((doc) => {
        const { type } = calculateStatus(doc.dueDate);
        if (type === "ok") ok++;
        if (type === "warning") warning++;
        if (type === "expired") expired++;
    });

    document.getElementById("statTotal").innerText = documents.length;
    document.getElementById("statOk").innerText = ok;
    document.getElementById("statWarning").innerText = warning;
    document.getElementById("statExpired").innerText = expired;
}

// ===== Modal de documento =====
function openDocModal() {
    if (!currentUser?.canCreate) {
        showToast("Você não tem permissão para cadastrar documentos.", "warning");
        return;
    }

    document.getElementById("docForm").reset();
    document.getElementById("docId").value = "";
    fillDocCompanySelect("");
    document.getElementById("modalTitle").innerText = "Novo Documento";
    document.getElementById("docModal").classList.remove("hidden");
}

function closeDocModal() {
    document.getElementById("docModal").classList.add("hidden");
}

function editDocument(id) {
    if (!currentUser?.canEdit) {
        showToast("Você não tem permissão para alterar documentos.", "warning");
        return;
    }

    const doc = documents.find((d) => d.id === id);
    if (!doc) return;

    document.getElementById("docId").value = doc.id;
    document.getElementById("docTitle").value = doc.title;
    fillDocCompanySelect(doc.companyId);
    document.getElementById("docCategory").value = doc.category;
    document.getElementById("docDueDate").value = doc.dueDate;
    document.getElementById("docNotes").value = doc.notes || "";
    document.getElementById("docFile").value = "";
    document.getElementById("modalTitle").innerText = "Editar Documento";
    document.getElementById("docModal").classList.remove("hidden");
}

// ===== Notificações =====
const TOAST_ICONS = {
    success: "fa-solid fa-circle-check text-emerald-400 text-base",
    warning: "fa-solid fa-triangle-exclamation text-amber-400 text-base",
    error: "fa-solid fa-circle-exclamation text-rose-400 text-base"
};

function showToast(message, type = "success") {
    const toast = document.getElementById("toast");
    document.getElementById("toastMessage").innerText = message;
    document.getElementById("toastIcon").className = TOAST_ICONS[type] || TOAST_ICONS.error;

    toast.classList.remove("translate-y-20", "opacity-0");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toast.classList.add("translate-y-20", "opacity-0");
    }, 3500);
}