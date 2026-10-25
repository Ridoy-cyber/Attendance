(() => {
    const originalSwitchMainPortal = window.switchMainPortal;
    const originalSwitchAdminSubTab = window.switchAdminSubTab;
    const state = {
        client: null,
        user: null,
        profile: null,
        pendingPortal: 'kiosk',
        logRefreshTimer: null
    };

    appConfig = {
        hqLat: 23.8103,
        hqLng: 90.4125,
        allowedRadiusMeters: 500,
        maxLocationAccuracyMeters: 100
    };
    employeeDirectory = [];
    attendanceLogs = [];
    isAdminAuthenticated = false;

    function showLoginMessage(message, isError = true) {
        const help = document.getElementById('loginHelp');
        help.innerText = message;
        help.classList.toggle('hidden', !message);
        help.classList.toggle('text-rose-600', isError);
        help.classList.toggle('text-slate-600', !isError);
    }

    function openLogin(message = '') {
        showLoginMessage(message);
        document.getElementById('pinModal').classList.remove('hidden');
        document.getElementById('loginEmail').focus();
    }

    function showCloudError(error) {
        console.error(error);
        showToast(error.message || 'Could not reach the shared attendance service.', 'error');
    }

    function mapLog(row) {
        return {
            timestamp: new Date(row.created_at).toLocaleString(),
            createdAt: row.created_at,
            empId: row.emp_id,
            empName: row.emp_name,
            empDept: row.emp_dept,
            type: row.type,
            lat: row.lat,
            lng: row.lng,
            accuracy: row.accuracy_meters,
            distance: row.distance,
            isGpsValid: row.is_gps_valid,
            note: row.note
        };
    }

    async function loadSharedData() {
        const [employeeResult, settingsResult] = await Promise.all([
            state.client.from('employees').select('id, name, dept, type, status').order('name'),
            state.client.from('app_settings').select('*').eq('id', 1).single()
        ]);

        if (employeeResult.error) throw employeeResult.error;
        if (settingsResult.error) throw settingsResult.error;

        employeeDirectory = employeeResult.data;
        const settings = settingsResult.data;
        appConfig.hqLat = settings.hq_lat;
        appConfig.hqLng = settings.hq_lng;
        appConfig.allowedRadiusMeters = settings.allowed_radius_meters;
        appConfig.maxLocationAccuracyMeters = settings.max_location_accuracy_meters || 100;

        updateMapGeofenceCircle();
        calculateGpsCompliance();
        loadAdminSettingsIntoUI();
        populateKioskEmployeeSelect();

        const employeeSelect = document.getElementById('empSelect');
        if (state.profile.role === 'employee') {
            employeeSelect.value = state.profile.employee_id;
            employeeSelect.disabled = true;
            autoFillCheckIn(state.profile.employee_id);
        } else {
            employeeSelect.disabled = false;
        }

        if (state.profile.role === 'admin') {
            const { data, error } = await state.client
                .from('attendance_logs')
                .select('*')
                .order('created_at', { ascending: false });
            if (error) throw error;
            attendanceLogs = data.map(mapLog);
            renderDirectoryTable();
            renderLogsTable();
        }
    }

    async function applySignedInUser(user) {
        const { data: profile, error } = await state.client
            .from('profiles')
            .select('id, role, employee_id')
            .eq('id', user.id)
            .single();

        if (error || !profile || (profile.role === 'employee' && !profile.employee_id)) {
            await state.client.auth.signOut();
            openLogin(error?.message || 'Ask your administrator to assign this account to an employee.');
            return false;
        }

        state.user = user;
        state.profile = profile;
        isAdminAuthenticated = profile.role === 'admin';

        try {
            await loadSharedData();
        } catch (loadError) {
            state.user = null;
            state.profile = null;
            isAdminAuthenticated = false;
            showCloudError(loadError);
            openLogin('Could not load account data. Check that the database schema has been applied.');
            return false;
        }

        document.getElementById('signOutBtn').classList.remove('hidden');
        document.getElementById('pinModal').classList.add('hidden');
        showToast(`Signed in as ${profile.role}.`, 'success');

        const target = state.pendingPortal === 'admin' && profile.role === 'admin' ? 'admin' : 'kiosk';
        originalSwitchMainPortal(target);

        clearInterval(state.logRefreshTimer);
        if (profile.role === 'admin') {
            state.logRefreshTimer = setInterval(async () => {
                const { data, error: refreshError } = await state.client
                    .from('attendance_logs')
                    .select('*')
                    .order('created_at', { ascending: false });
                if (!refreshError) {
                    attendanceLogs = data.map(mapLog);
                    renderLogsTable();
                }
            }, 15000);
        }
        return true;
    }

    window.onload = async function() {
        initClock();
        initMap();
        requestGeolocation();

        const projectUrl = window.GEOGUARD_SUPABASE_URL;
        const publicKey = window.GEOGUARD_SUPABASE_ANON_KEY;
        if (!window.supabase || !projectUrl || !publicKey) {
            openLogin('Set the Supabase project URL and public anon key in supabase-config.js first.');
            return;
        }

        state.client = window.supabase.createClient(projectUrl, publicKey);
        state.client.auth.onAuthStateChange(event => {
            if (event === 'SIGNED_OUT') {
                state.user = null;
                state.profile = null;
                isAdminAuthenticated = false;
                employeeDirectory = [];
                attendanceLogs = [];
                clearInterval(state.logRefreshTimer);
                document.getElementById('empSelect').value = '';
                document.getElementById('empSelect').disabled = false;
                document.getElementById('empId').value = '';
                document.getElementById('empDept').value = '';
                document.getElementById('signOutBtn').classList.add('hidden');
                document.getElementById('viewAdmin').classList.add('hidden');
                document.getElementById('viewKiosk').classList.remove('hidden');
                openLogin();
            }
        });

        const { data, error } = await state.client.auth.getSession();
        if (error) {
            openLogin(error.message);
        } else if (data.session) {
            await applySignedInUser(data.session.user);
        } else {
            openLogin();
        }

        updateCheckInEligibility();
    };

    window.switchMainPortal = function(targetPortal) {
        if (!state.user) {
            state.pendingPortal = targetPortal;
            openLogin();
            return;
        }
        if (targetPortal === 'admin' && state.profile.role !== 'admin') {
            showToast('This account does not have admin access.', 'error');
            return;
        }
        originalSwitchMainPortal(targetPortal);
    };

    window.switchAdminSubTab = function(subTabId) {
        if (state.profile?.role !== 'admin') {
            showToast('This account does not have admin access.', 'error');
            return;
        }
        originalSwitchAdminSubTab(subTabId);
    };

    window.sendSignInLink = async function(event) {
        event.preventDefault();
        if (!state.client) {
            showLoginMessage('Supabase is not configured.');
            return;
        }

        const button = document.getElementById('loginSubmitBtn');
        button.disabled = true;
        showLoginMessage('');
        const redirectTo = window.location.protocol === 'file:'
            ? 'https://ridoy-cyber.github.io/Attendance/'
            : window.location.href.split('#')[0];
        const { error } = await state.client.auth.signInWithOtp({
            email: document.getElementById('loginEmail').value.trim(),
            options: { emailRedirectTo: redirectTo, shouldCreateUser: false }
        });
        button.disabled = false;

        if (error) {
            showLoginMessage(error.message);
            return;
        }
        showLoginMessage('If this email has an active GeoGuard account, we sent a sign-in link. Open it to finish signing in.', false);
    };

    window.signOutUser = async function() {
        if (!state.client) return;
        const { error } = await state.client.auth.signOut();
        if (error) showCloudError(error);
    };

    window.updateCheckInEligibility = function() {
        const submitButton = document.getElementById('submitBtn');
        const warning = document.getElementById('locationGateWarning');
        const accuracy = Number(userState.accuracy);
        const hasReliableFix = Number.isFinite(accuracy)
            && accuracy <= appConfig.maxLocationAccuracyMeters;
        const canCheckIn = Boolean(state.user && state.profile && userState.isGpsValid && hasReliableFix);

        submitButton.disabled = !canCheckIn;
        submitButton.classList.toggle('opacity-50', !canCheckIn);
        submitButton.classList.toggle('cursor-not-allowed', !canCheckIn);
        warning.classList.toggle('hidden', canCheckIn || !state.user);
    };

    window.requestGeolocation = function() {
        if (!navigator.geolocation) {
            userState.lat = null;
            userState.lng = null;
            userState.accuracy = null;
            userState.distance = null;
            userState.isGpsValid = false;
            document.getElementById('hqDistanceLabel').innerText = 'Location is unavailable on this device.';
            document.getElementById('kioskGpsBadge').innerText = 'Unavailable';
            updateCheckInEligibility();
            return;
        }

        state.locationWatchId = navigator.geolocation.watchPosition(position => {
            userState.lat = position.coords.latitude;
            userState.lng = position.coords.longitude;
            userState.accuracy = position.coords.accuracy;
            calculateGpsCompliance();
            updateCheckInEligibility();
        }, () => {
            userState.lat = null;
            userState.lng = null;
            userState.accuracy = null;
            userState.distance = null;
            userState.isGpsValid = false;
            document.getElementById('hqDistanceLabel').innerText = 'Allow location access to record your position.';
            document.getElementById('kioskGpsBadge').innerText = 'Unavailable';
            updateCheckInEligibility();
        }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
    };

    window.submitCheckIn = async function(event) {
        event.preventDefault();
        if (!state.user || !state.profile) {
            openLogin();
            return;
        }

        let position;
        try {
            position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject,
                { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }));
        } catch {
            showToast('Could not get a fresh device location. Allow location access and try again.', 'error');
            requestGeolocation();
            return;
        }
        userState.lat = position.coords.latitude;
        userState.lng = position.coords.longitude;
        userState.accuracy = position.coords.accuracy;
        calculateGpsCompliance();
        const accuracy = Number(userState.accuracy);
        if (!userState.isGpsValid || !Number.isFinite(accuracy)
            || accuracy > appConfig.maxLocationAccuracyMeters) {
            updateCheckInEligibility();
            showToast('Check-in requires a reliable location inside the HQ geofence.', 'error');
            requestGeolocation();
            return;
        }

        const empId = state.profile.role === 'employee'
            ? state.profile.employee_id
            : document.getElementById('empSelect').value;
        const employee = employeeDirectory.find(item => item.id === empId);
        if (!employee || employee.status !== 'Active') {
            showToast('No active employee is assigned to this account.', 'error');
            return;
        }

        const entry = {
            user_id: state.user.id,
            emp_id: employee.id,
            emp_name: employee.name,
            emp_dept: employee.dept,
            type: document.getElementById('checkinType').value,
            ip: 'N/A',
            is_ip_valid: true,
            lat: userState.lat,
            lng: userState.lng,
            accuracy_meters: accuracy,
            distance: userState.distance,
            is_gps_valid: userState.isGpsValid,
            note: document.getElementById('checkinNote').value.trim() || 'N/A'
        };
        const { error } = await state.client.from('attendance_logs').insert(entry);
        if (error) {
            showCloudError(error);
            return;
        }

        showToast(`Attendance (${entry.type}) saved for ${employee.name}.`, 'success');
        document.getElementById('checkinNote').value = '';
        if (state.profile.role === 'admin') {
            const { data, error: loadError } = await state.client
                .from('attendance_logs').select('*').order('created_at', { ascending: false });
            if (!loadError) {
                attendanceLogs = data.map(mapLog);
                renderLogsTable();
            }
        } else {
            document.getElementById('checkinType').value = 'Clock In';
        }
        if (state.profile.role === 'admin') {
            document.getElementById('empSelect').value = '';
            document.getElementById('empId').value = '';
            document.getElementById('empDept').value = '';
        }
    };

    window.saveEmployeeRecord = async function(event) {
        event.preventDefault();
        if (state.profile?.role !== 'admin') return;

        const editIndex = parseInt(document.getElementById('directoryEditIndex').value, 10);
        const record = {
            id: document.getElementById('dirEmpId').value.trim(),
            name: document.getElementById('dirEmpName').value.trim(),
            dept: document.getElementById('dirEmpDept').value.trim() || 'General',
            type: document.getElementById('dirEmpType').value,
            status: document.getElementById('dirEmpStatus').value
        };
        const request = editIndex === -1
            ? state.client.from('employees').insert(record)
            : state.client.from('employees').update(record).eq('id', employeeDirectory[editIndex].id);

        const { error } = await request;
        if (error) {
            showCloudError(error);
            return;
        }
        await loadSharedData();
        resetDirectoryForm();
        renderDirectoryTable();
        showToast(editIndex === -1 ? 'Employee added.' : 'Employee updated.', 'success');
    };

    window.deleteEmployeeRecord = async function(index) {
        if (state.profile?.role !== 'admin') return;
        const employee = employeeDirectory[index];
        if (!employee) return;
        const { error } = await state.client.from('employees')
            .update({ status: 'Inactive' }).eq('id', employee.id);
        if (error) {
            showCloudError(error);
            return;
        }
        await loadSharedData();
        renderDirectoryTable();
        showToast(`${employee.name} marked inactive.`, 'success');
    };

    window.clearLogs = async function() {
        if (state.profile?.role !== 'admin') return;
        const { error } = await state.client.from('attendance_logs')
            .delete().gte('created_at', '1970-01-01T00:00:00Z');
        if (error) {
            showCloudError(error);
            return;
        }
        attendanceLogs = [];
        renderLogsTable();
        showToast('Shared attendance logs cleared.', 'info');
    };

    window.loadAdminSettingsIntoUI = function() {
        document.getElementById('cfgHqLat').value = appConfig.hqLat;
        document.getElementById('cfgHqLng').value = appConfig.hqLng;
        document.getElementById('cfgRadius').value = appConfig.allowedRadiusMeters;
    };

    window.saveHqSettings = async function(event) {
        event.preventDefault();
        if (state.profile?.role !== 'admin') return;
        const values = {
            hq_lat: Number(document.getElementById('cfgHqLat').value),
            hq_lng: Number(document.getElementById('cfgHqLng').value),
            allowed_radius_meters: Number(document.getElementById('cfgRadius').value)
        };
        const { error } = await state.client.from('app_settings').update(values).eq('id', 1);
        if (error) {
            showCloudError(error);
            return;
        }
        appConfig.hqLat = values.hq_lat;
        appConfig.hqLng = values.hq_lng;
        appConfig.allowedRadiusMeters = values.allowed_radius_meters;
        updateMapGeofenceCircle();
        calculateGpsCompliance();
        updateCheckInEligibility();
        showToast('Geofence settings updated.', 'success');
    };

    window.changeAdminPin = async function(event) {
        event.preventDefault();
        const password = document.getElementById('cfgNewPin').value;
        if (password.length < 8) {
            showToast('Password should be at least 8 characters.', 'error');
            return;
        }
        const { error } = await state.client.auth.updateUser({ password });
        if (error) {
            showCloudError(error);
            return;
        }
        document.getElementById('cfgNewPin').value = '';
        showToast('Account password changed.', 'success');
    };

})();
