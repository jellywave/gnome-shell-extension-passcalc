/**
    Copyright (C) 2015 Tomáš Havlas <tomashavlas@raven-systems.eu>
    Copyright (C) 2013 Thilo Maurer <maurer.thilo@gmail.com>

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.
**/

const Clutter = imports.gi.Clutter;
const Meta = imports.gi.Meta;
const Lang = imports.lang;
const St = imports.gi.St;
const Shell = imports.gi.Shell;

const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

const Gettext = imports.gettext.domain('gnome-shell-extension-passcalc');
const _ = Gettext.gettext;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Convenience = Me.imports.convenience;
const C = Me.imports.config;
const Clipboard = Me.imports.clipboard;
const E = Me.imports.enum;
const SJCL = Me.imports.libsjcl;

const ID_ENTRY_FOCUS_TIMEOUT = 20;

const PasswordCalculator = Lang.Class({
    Name: 'PasswordCalculator',
    Extends: PanelMenu.Button,

    _init: function() {
        this.parent(0.0, _('PassCalc'));
        Me.extension = this;

        this._buildWidget();
    },

    destroy: function() {
        this.parent();
    },

    getSettings: function() {
        if (!this._settings) {
            this._loadSettings();
        }

        return this._settings;
    },

    getPasswordHash: function() {
        return this._passwordHash;
    },

    setPasswordHash: function(passwordHash) {
        this._passwordHash = passwordHash;
    },

    onOpenPasswordCalcualtor: function() {
        this.menu.open();
    },

    clearInput: function() {
        this.domainEntry.set_text('');
        this.passphraseEntry.set_text('');
        this.passwordBox.set_text(_('your password'));
    },

    computePassword: function(o, e) {
        let domain = this.domainEntry.get_text();
        let passphrase = this.passphraseEntry.get_text();
        
        if (domain && passphrase) {
            let salt = this.getSettings().get_string(C.SETTINGS_PASSWORD_SALT);
            let password = _('unavailable');
            let passwordLength = this.getSettings().get_int(C.SETTINGS_PASSWORD_LENGTH);

            switch(this.getSettings().get_enum(C.SETTINGS_COMP_METHOD)) {
                case E.COMP_METHOD.CONCAT:
                    password = this._computePasswordConcat(domain, passphrase, salt, passwordLength);
                    break;
                case E.COMP_METHOD.KDF:
                    password = this._computePasswordKdf(domain, passphrase, salt, passwordLength);
                    break;
            }

            password = this._filterPasswordCharacters(password);
            
            if (password == _('unavailable')) {
                this.passwordBox.set_text(password);
                Main.notify(_('Unable to compute password with current settings.'));
                return;
            }

            this.passwordBox.set_text(password.substr(0, 3) + '.........' + password.substr(password.length-3, password.length));

            let key_press = e.get_key_symbol();
            if (key_press == Clutter.Return || key_press == Clutter.KP_Enter) {
                Clipboard.set(password);
                this.menu.close();

                if (this.getSettings().get_boolean(C.SETTINGS_SHOW_NOTIFICATION)) {
                    Main.notify(_('PassCalc: Password copied to clipboard.'));
                }

                
                this.setPasswordHash(SJCL.hash.sha512(password));
                Mainloop.timeout_add(this.getSettings().get_int(C.SETTINGS_CLIPBOARD_TIMEOUT), Lang.bind(this, function() {
                    Clipboard.get(Lang.bind(this, function(cb, text) {
                        if (this.getPasswordHash() == SJCL.hash.sha512(text)) {
                            Clipboard.clear();
                        }

                        this.setPasswordHash('');
                    }));
                }));
            }
        } else {
            this.passwordBox.set_text(_('your password'));
        }
    },


    _buildWidget: function() {
        let hbox = new St.BoxLayout({
            style_class: 'panel-status-menu-box'
        });
        let icon = new St.Icon({
            icon_name: 'dialog-password-symbolic',
            style_class: 'system-status-icon'
        });
        hbox.add_child(icon);
        hbox.add_child(PopupMenu.arrowIcon(St.Side.BOTTOM));
        this.actor.add_child(hbox);

        let controlForm = new PopupMenu.PopupMenuSection({
            reactive: false
        });
        controlForm.actor.add_style_class_name('passcalc');

        this.domainEntry = new St.Entry({
            name: 'domainEntry',
            hint_text: _('domain'),
            track_hover: true,
            can_focus: true,
            style_class: 'search-entry first-entry'
        });
        this.domainEntry.clutter_text.connect('key-release-event', Lang.bind(this, this.computePassword));
        controlForm.actor.add_actor(this.domainEntry);

        this.passphraseEntry = new St.Entry({
            name: 'passphraseEntry',
            hint_text: _('passphrase'),
            track_hover: true,
            can_focus: true,
            style_class: 'search-entry last-entry'
        });
        this.passphraseEntry.clutter_text.connect('text-changed', Lang.bind(this, function(o, e) {
            let pwc = '';
            if (this.passphraseEntry.get_text() != '') {
                pwc = '\u25cf'; // ● U+25CF BLACK CIRCLE
            }
            this.passphraseEntry.clutter_text.set_password_char(pwc);
        }));
        this.passphraseEntry.clutter_text.connect('key-release-event', Lang.bind(this, this.computePassword));
        controlForm.actor.add_actor(this.passphraseEntry);

        this.passwordBox = new St.Label({
            text: _('your password'),
            style_class: 'password-box'
        });
        controlForm.actor.add_actor(this.passwordBox);


        this.menu.addMenuItem(controlForm);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.connect('open-state-changed', Lang.bind(this, function(sender, open) {
            this.clearInput();
            if (open) {
                Mainloop.timeout_add(ID_ENTRY_FOCUS_TIMEOUT, Lang.bind(this, function() {
                    this.domainEntry.grab_key_focus();
                }));
            }
        }));

    },

    _computePasswordConcat: function(domain, passphrase, salt, length) {
        let passwordString = domain + passphrase + salt;

        switch (this.getSettings().get_enum(C.SETTINGS_HASH_TYPE)) {
            case E.HASH_TYPE.SHA256:
                if (length <= 44) {
                    return SJCL.hash.sha256(passwordString).substr(0, length);
                }
            case E.HASH_TYPE.SHA512:
                if (length <= 88) {
                    return SJCL.hash.sha512(passwordString).substr(0, length);
                }
        }

        return _('unavailable');
    },

    _computePasswordKdf: function(domain, passphrase, salt, length) {
        switch (this.getSettings().get_enum(C.SETTINGS_KDF_TYPE)) {
            case E.KDF_TYPE.HKDF_SHA256:
                return SJCL.hkdf.sha256(domain, passphrase, salt, length);
            case E.KDF_TYPE.HKDF_SHA512:
                return SJCL.hkdf.sha512(domain, passphrase, salt, length);
            case E.KDF_TYPE.PBKDF2_HMAC_SHA256:
                return SJCL.pbkdf2.sha256(domain, passphrase, salt, length);
        }

        return _('unavailable');
    },

    _filterPasswordCharacters: function(password) {
        let charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
        let allowed = charset;

        if (this.getSettings().get_boolean(C.SETTINGS_REMOVE_LOWER_ALPHA)) {
            allowed = allowed.substr(0, allowed.indexOf("a")) + allowed.substr(allowed.indexOf("z")+1, allowed.length);
        }
        if (this.getSettings().get_boolean(C.SETTINGS_REMOVE_UPPER_ALPHA)) {
            allowed = allowed.substr(0, allowed.indexOf("A")) + allowed.substr(allowed.indexOf("Z")+1, allowed.length);
        }
        if (this.getSettings().get_boolean(C.SETTINGS_REMOVE_NUMERIC)) {
            allowed = allowed.substr(0, allowed.indexOf("0")) + allowed.substr(allowed.indexOf("9")+1, allowed.length);
        }
        if (this.getSettings().get_boolean(C.SETTINGS_REMOVE_SYMBOLS)) {
            allowed = allowed.substr(0, allowed.indexOf("+")) + allowed.substr(allowed.indexOf("=")+1, allowed.length);
        }

        if (allowed.length == charset.length) {
            return password;
        }

        if (allowed.length < 4) {
            return _('unavailable');
        }

        let translated = '';
        for (let i=0; i<password.length; i++) {
            translated += allowed[charset.indexOf(password[i])%allowed.length];
        }

        return translated;
    },

    _loadSettings: function() {
        this._settings = Convenience.getSettings();
    }
});

function init() {
    Convenience.initTranslations();
}

let _indicator;

function enable() {
    _indicator = new PasswordCalculator;
    Main.panel.addToStatusArea('passcalc', _indicator);
    Main.wm.addKeybinding(C.SETTINGS_SHORTCUT_KEYBIND, Me.extension.getSettings(), Meta.KeyBindingFlags.NONE,
                          Shell.ActionMode.NORMAL, Lang.bind(Me.extension, Me.extension.onOpenPasswordCalcualtor));
}

function disable() {
    _indicator.destroy();
    Main.wm.removeKeybinding(C.SETTINGS_SHORTCUT_KEYBIND);
}
