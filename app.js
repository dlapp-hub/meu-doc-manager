// ===== Configuração =====
// Cole aqui a mesma chave publishable (sb_publishable_...) ou anon (eyJ...) que já está no seu app.js.
const SUPABASE_URL = "https://hipsweaqpqoxmffwvxsr.supabase.co";
const SUPABASE_KEY = "sb_publishable_zONl2i0QwkMPcQeyAxeYug_084e4zuJ";

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
let companies = [];      // todas as empresas (ativas e inativas)
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

// ===== Utilitários de segurança =====
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
    el.classList.