(() => {
    const originalSwitchMainPortal = window.switchMainPortal;
    const originalSwitchAdminSubTab = window.switchAdminSubTab;
    const state = {
        client: null,
        user: null,
        profile: null,
        pendingPortal: 'kiosk',
        logRefreshTimer: null,
        locationRulesAvailable: false,
        employeeLocationFieldsAvailable: false,
        photoCaptureAvailable: false
    };
    let attendanceCameraStream = null;
    let resolveAttendancePhoto = null;

    appConfig = {
        locationRules: []
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

    function setLocationRulesAvailability(available) {
        state.locationRulesAvailable = available;
        const warning = document.getElementById('locationRulesSetupWarning');
        if (warning) warning.classList.toggle('hidden', available);
        ['ruleName', 'ruleLat', 'ruleLng', 'useCurrentLocationForRuleBtn', 'ruleRadius', 'ruleDecision', 'saveLocationRuleBtn']
            .forEach(id => {
                const control = document.getElementById(id);
                if (control) control.disabled = !available;
            });
    }

    function setEmployeeLocationAvailability(available) {
        state.employeeLocationFieldsAvailable = available;
        const warning = document.getElementById('employeeLocationSetupWarning');
        if (warning) warning.classList.toggle('hidden', available);
        ['dirEmpLat', 'dirEmpLng', 'useCurrentEmployeeLocationBtn'].forEach(id => {
            const control = document.getElementById(id);
            if (control) control.disabled = !available;
        });
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
            facePhotoData: row.face_photo_data,
            facePhotoExpiresAt: row.face_photo_expires_at,
            note: row.note
        };
    }

    function stopAttendanceCamera(photoData = null) {
        if (attendanceCameraStream) {
            attendanceCameraStream.getTracks().forEach(track => track.stop());
            attendanceCameraStream = null;
        }
        const video = document.getElementById('attendanceCameraPreview');
        video.srcObject = null;
        const modal = document.getElementById('attendancePhotoModal');
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        if (resolveAttendancePhoto) {
            const resolve = resolveAttendancePhoto;
            resolveAttendancePhoto = null;
            resolve(photoData);
        }
    }

    function captureAttendancePhoto() {
        return new Promise(resolve => {
            const modal = document.getElementById('attendancePhotoModal');
            const video = document.getElementById('attendanceCameraPreview');
            const errorLabel = document.getElementById('attendanceCameraError');
            resolveAttendancePhoto = resolve;
            errorLabel.classList.add('hidden');

            if (!navigator.mediaDevices?.getUserMedia) {
                resolveAttendancePhoto = null;
                showToast('This browser cannot access a camera. Use HTTPS and a camera-enabled device.', 'error');
                resolve(null);
                return;
            }

            navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
                audio: false
            }).then(async stream => {
                attendanceCameraStream = stream;
                video.srcObject = stream;
                modal.classList.remove('hidden');
                modal.classList.add('flex');
                try {
                    await video.play();
                } catch (error) {
                    showCloudError(error);
                    stopAttendanceCamera(null);
                }
            }).catch(error => {
                resolveAttendancePhoto = null;
                console.error(error);
                showToast('Camera access is required to record attendance. Allow camera access and try again.', 'error');
                resolve(null);
            });
        });
    }

    window.cancelAttendancePhoto = function() {
        stopAttendanceCamera(null);
    };

    window.confirmAttendancePhoto = function() {
        const video = document.getElementById('attendanceCameraPreview');
        const canvas = document.getElementById('attendancePhotoCanvas');
        const errorLabel = document.getElementById('attendanceCameraError');
        if (!video.videoWidth || !video.videoHeight) {
            errorLabel.innerText = 'Camera is not ready yet. Wait a moment and try again.';
            errorLabel.classList.remove('hidden');
            return;
        }

        const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        const photo = canvas.toDataURL('image/jpeg', 0.68);
        if (photo.length > 600000) {
            errorLabel.innerText = 'Photo is too large. Move closer to better lighting and capture again.';
            errorLabel.classList.remove('hidden');
            return;
        }
        stopAttendanceCamera(photo);
    };

    async function loadSharedData() {
        const employeeResult = await state.client.from('employees').select('id, name, dept, type, status').order('name');
        if (employeeResult.error) throw employeeResult.error;
        const photoSchemaResult = await state.client.from('attendance_logs')
            .select('face_photo_data, face_photo_expires_at').limit(1);
        state.photoCaptureAvailable = !photoSchemaResult.error;
        document.getElementById('photoCaptureSetupWarning').classList.toggle('hidden', state.photoCaptureAvailable);
        document.getElementById('photoConsentBlock').classList.toggle('hidden', !state.photoCaptureAvailable);
        document.getElementById('photoConsent').required = state.photoCaptureAvailable;
        employeeDirectory = employeeResult.data;
        populateKioskEmployeeSelect();

        const employeeSelect = document.getElementById('empSelect');
        if (state.profile.role === 'employee') {
            employeeSelect.value = state.profile.employee_id;
            employeeSelect.disabled = true;
            autoFillCheckIn(state.profile.employee_id);
        } else {
            employeeSelect.disabled = false;
            autoFillCheckIn(employeeSelect.value);
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

    async function reloadLocationRules() {
        const { data, error } = await state.client.from('location_rules')
            .select('*').order('created_at', { ascending: false });
        if (error) throw error;
        appConfig.locationRules = data || [];
        renderLocationRules();
        updateMapGeofenceCircle();
        calculateGpsCompliance();
        updateCheckInEligibility();
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
            const detail = loadError?.message || 'Unknown database error';
            const code = loadError?.code ? ` (${loadError.code})` : '';
            openLogin(`Signed in, but account data could not load: ${detail}${code}`);
            return false;
        }

        document.getElementById('signOutBtn').classList.remove('hidden');
        document.getElementById('pinInput').value = '';
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

    window.verifyAdminPin = async function(event) {
        event.preventDefault();
        if (!state.client) {
            showLoginMessage('Supabase is not configured.');
            return;
        }
        const button = document.getElementById('loginSubmitBtn');
        button.disabled = true;
        showLoginMessage('');
        const { data, error } = await state.client.auth.signInWithPassword({
            email: document.getElementById('loginEmail').value.trim(),
            password: document.getElementById('pinInput').value
        });
        button.disabled = false;
        if (error) {
            showLoginMessage(error.message);
            return;
        }
        await applySignedInUser(data.user);
    };

    window.signOutUser = async function() {
        if (!state.client) return;
        const { error } = await state.client.auth.signOut();
        if (error) showCloudError(error);
    };

    window.updateCheckInEligibility = function() {
        const submitButton = document.getElementById('submitBtn');
        const canCheckIn = Boolean(state.user && state.profile);

        submitButton.disabled = !canCheckIn;
        submitButton.classList.toggle('opacity-50', !canCheckIn);
        submitButton.classList.toggle('cursor-not-allowed', !canCheckIn);
    };

    window.requestGeolocation = function() {
        if (!navigator.geolocation) {
            userState.lat = null;
            userState.lng = null;
            userState.accuracy = null;
            userState.distance = null;
            userState.isGpsValid = false;
            if (userMarker) map.removeLayer(userMarker);
            if (userAccuracyCircle) map.removeLayer(userAccuracyCircle);
            document.getElementById('hqDistanceLabel').innerText = 'Location is unavailable on this device.';
            document.getElementById('kioskGpsBadge').innerText = 'Unavailable';
            updateCheckInEligibility();
            return;
        }

        navigator.geolocation.getCurrentPosition(position => {
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
            if (userMarker) map.removeLayer(userMarker);
            if (userAccuracyCircle) map.removeLayer(userAccuracyCircle);
            document.getElementById('hqDistanceLabel').innerText = 'Allow location access to record your position.';
            document.getElementById('kioskGpsBadge').innerText = 'Unavailable';
            updateCheckInEligibility();
        }, { enableHighAccuracy: true, timeout: 10000 });
    };

    window.submitCheckIn = async function(event) {
        event.preventDefault();
        if (!state.user || !state.profile) {
            openLogin();
            return;
        }
        if (state.photoCaptureAvailable && !document.getElementById('photoConsent').checked) {
            showToast('Agree to the 20-day attendance photo notice before submitting.', 'error');
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

        const submitButton = document.getElementById('submitBtn');
        submitButton.disabled = true;
        let facePhoto = null;
        if (state.photoCaptureAvailable) {
            facePhoto = await captureAttendancePhoto();
            if (!facePhoto) {
                submitButton.disabled = false;
                return;
            }
        }

        const entry = {
            user_id: state.user.id,
            emp_id: employee.id,
            emp_name: employee.name,
            emp_dept: employee.dept,
            type: document.getElementById('checkinType').value,
            ip: 'N/A',
            is_ip_valid: true,
            is_gps_valid: true,
            note: document.getElementById('checkinNote').value.trim() || 'N/A'
        };
        if (state.photoCaptureAvailable) entry.face_photo_data = facePhoto;
        const { error } = await state.client.from('attendance_logs').insert(entry);
        if (error) {
            submitButton.disabled = false;
            showCloudError(error);
            return;
        }

        showToast(`Attendance (${entry.type}) saved for ${employee.name}.`, 'success');
        document.getElementById('checkinNote').value = '';
        document.getElementById('photoConsent').checked = false;
        submitButton.disabled = false;
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

    window.useCurrentLocationForRule = async function() {
        if (state.profile?.role !== 'admin') return;
        if (!state.locationRulesAvailable) {
            showToast('Apply the latest supabase/schema.sql to enable location rules.', 'error');
            return;
        }
        try {
            const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
                resolve, reject, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 }
            ));
            document.getElementById('ruleLat').value = position.coords.latitude;
            document.getElementById('ruleLng').value = position.coords.longitude;
            showToast(`Coordinates filled (reported accuracy ±${Math.round(position.coords.accuracy)}m).`, 'success');
        } catch {
            showToast('Could not read this device location. Allow precise location and try again.', 'error');
        }
    };

    window.useCurrentLocationForEmployee = async function() {
        if (state.profile?.role !== 'admin') return;
        if (!state.employeeLocationFieldsAvailable) {
            showToast('Run the latest supabase/schema.sql to enable employee coordinates.', 'error');
            return;
        }
        try {
            const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
                resolve, reject, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 }
            ));
            document.getElementById('dirEmpLat').value = position.coords.latitude;
            document.getElementById('dirEmpLng').value = position.coords.longitude;
            showToast(`Employee location filled (reported accuracy ±${Math.round(position.coords.accuracy)}m).`, 'success');
        } catch {
            showToast('Could not read this device location. Allow precise location and try again.', 'error');
        }
    };

    window.saveLocationRule = async function(event) {
        event.preventDefault();
        if (state.profile?.role !== 'admin') return;
        if (!state.locationRulesAvailable) {
            showToast('Apply the latest supabase/schema.sql to enable location rules.', 'error');
            return;
        }
        const rule = {
            name: document.getElementById('ruleName').value.trim(),
            lat: Number(document.getElementById('ruleLat').value),
            lng: Number(document.getElementById('ruleLng').value),
            radius_meters: Number(document.getElementById('ruleRadius').value),
            decision: document.getElementById('ruleDecision').value,
            is_active: true
        };
        if (!rule.name || !Number.isFinite(rule.lat) || rule.lat < -90 || rule.lat > 90
            || !Number.isFinite(rule.lng) || rule.lng < -180 || rule.lng > 180
            || !Number.isInteger(rule.radius_meters) || rule.radius_meters < 1 || rule.radius_meters > 50000
            || !['approve', 'block'].includes(rule.decision)) {
            showToast('Enter a valid name, coordinate pair, radius, and decision.', 'error');
            return;
        }
        const { error } = await state.client.from('location_rules').insert(rule);
        if (error) {
            showCloudError(error);
            return;
        }
        try {
            await reloadLocationRules();
            document.getElementById('locationRuleForm')?.reset();
            document.getElementById('ruleRadius').value = 500;
            showToast(`${rule.decision === 'approve' ? 'Approved' : 'Blocked'} location saved.`, 'success');
        } catch (loadError) {
            showCloudError(loadError);
        }
    };

    window.toggleLocationRule = async function(id, isActive) {
        if (state.profile?.role !== 'admin') return;
        if (!state.locationRulesAvailable) return;
        const { error } = await state.client.from('location_rules').update({ is_active: isActive }).eq('id', id);
        if (error) {
            showCloudError(error);
            return;
        }
        try {
            await reloadLocationRules();
            showToast(`Location rule ${isActive ? 'activated' : 'paused'}.`, 'success');
        } catch (loadError) {
            showCloudError(loadError);
        }
    };

    window.changeLocationRuleDecision = async function(id, decision) {
        if (state.profile?.role !== 'admin' || !['approve', 'block'].includes(decision)) return;
        if (!state.locationRulesAvailable) return;
        const { error } = await state.client.from('location_rules').update({ decision }).eq('id', id);
        if (error) {
            showCloudError(error);
            return;
        }
        try {
            await reloadLocationRules();
            showToast(`Location is now ${decision === 'approve' ? 'approved' : 'blocked'}.`, 'success');
        } catch (loadError) {
            showCloudError(loadError);
        }
    };

    window.deleteLocationRule = async function(id) {
        if (state.profile?.role !== 'admin' || !window.confirm('Delete this location rule?')) return;
        if (!state.locationRulesAvailable) return;
        const { error } = await state.client.from('location_rules').delete().eq('id', id);
        if (error) {
            showCloudError(error);
            return;
        }
        try {
            await reloadLocationRules();
            showToast('Location rule deleted.', 'success');
        } catch (loadError) {
            showCloudError(loadError);
        }
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
        document.getElementById('cfgMaxAccuracy').value = appConfig.maxLocationAccuracyMeters;
    };

    window.saveHqSettings = async function(event) {
        event.preventDefault();
        if (state.profile?.role !== 'admin') return;
        const values = {
            hq_lat: Number(document.getElementById('cfgHqLat').value),
            hq_lng: Number(document.getElementById('cfgHqLng').value),
            allowed_radius_meters: Number(document.getElementById('cfgRadius').value),
            max_location_accuracy_meters: Number(document.getElementById('cfgMaxAccuracy').value)
        };
        if (!Number.isFinite(values.max_location_accuracy_meters)
            || values.max_location_accuracy_meters < 1 || values.max_location_accuracy_meters > 5000) {
            showToast('Maximum GPS accuracy must be between 1 and 5000 meters.', 'error');
            return;
        }
        const { error } = await state.client.from('app_settings').update(values).eq('id', 1);
        if (error) {
            showCloudError(error);
            return;
        }
        appConfig.hqLat = values.hq_lat;
        appConfig.hqLng = values.hq_lng;
        appConfig.allowedRadiusMeters = values.allowed_radius_meters;
        appConfig.maxLocationAccuracyMeters = values.max_location_accuracy_meters;
        updateMapGeofenceCircle();
        calculateGpsCompliance();
        updateCheckInEligibility();
        showToast('Geofence settings updated.', 'success');
    };

    window.setHqToCurrentLocation = async function() {
        if (state.profile?.role !== 'admin') {
            showToast('Only an administrator can change the HQ location.', 'error');
            return;
        }
        if (!navigator.geolocation) {
            showToast('This device does not provide location access.', 'error');
            return;
        }

        const button = document.getElementById('setHqCurrentLocationBtn');
        button.disabled = true;
        try {
            const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
                resolve, reject, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 }
            ));
            const latitude = position.coords.latitude;
            const longitude = position.coords.longitude;
            const { error } = await state.client.from('app_settings')
                .update({ hq_lat: latitude, hq_lng: longitude }).eq('id', 1);
            if (error) {
                showCloudError(error);
                return;
            }

            appConfig.hqLat = latitude;
            appConfig.hqLng = longitude;
            userState.lat = latitude;
            userState.lng = longitude;
            userState.accuracy = position.coords.accuracy;
            document.getElementById('cfgHqLat').value = latitude;
            document.getElementById('cfgHqLng').value = longitude;
            updateMapGeofenceCircle();
            calculateGpsCompliance();
            updateCheckInEligibility();
            showToast(`HQ saved at this device location (reported accuracy ±${Math.round(position.coords.accuracy)}m).`, 'success');
        } catch {
            showToast('Could not read this device location. Allow precise location and try again.', 'error');
        } finally {
            button.disabled = false;
        }
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
