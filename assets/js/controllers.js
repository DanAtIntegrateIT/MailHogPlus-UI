var mailhogApp = angular.module('mailhogApp', []);

mailhogApp.directive('targetBlank', function(){
  return {
    link : function(scope, element, attributes){
      element.on('load', function() {
        var a = element.contents().find('a');
        a.attr('target', '_blank');
      });
    }
  };
});

function guid() {
  function s4() {
    return Math.floor((1 + Math.random()) * 0x10000)
               .toString(16)
               .substring(1);
  }
  return s4() + s4() + '-' + s4() + '-' + s4() + '-' +
         s4() + '-' + s4() + s4() + s4();
}

mailhogApp.directive('ngKeyEnter', function () {
  return function (scope, element, attrs) {
    element.bind("keydown keypress", function (event) {
      if(event.which === 13) {
        scope.$apply(function (){
          scope.$eval(attrs.ngKeyEnter);
        });
        event.preventDefault();
      }
    });
  };
});

mailhogApp.controller('MailCtrl', function ($scope, $http, $sce, $timeout, $document) {
  $scope.host = apiHost;

  $scope.cache = {};
  $scope.previewAllHeaders = false;

  $scope.eventsPending = {};
  $scope.eventCount = 0;
  $scope.eventDone = 0;
  $scope.eventFailed = 0;

  $scope.hasEventSource = false;
  $scope.source = null;

  $scope.itemsPerPage = 50
  $scope.startIndex = 0
  $scope.sortOrder = "desc";

  $scope.viewMode = "columns";
  $scope.columnsListWidth = 46;
  $scope.stackedListHeight = 48;
  $scope.selectedMessageID = null;
  $scope.autoSelectFirstOnNextRefresh = false;
  $scope.restoreMessageIDOnNextRefresh = null;
  $scope.lastSelectedMessageByFolder = {};
  $scope.pendingSavedFolderSelection = null;
  $scope.showFavoritesOnly = false;
  $scope.favoriteStateByMessageID = {};
  $scope.readStateByMessageID = {};
  $scope.attachmentCacheByMessageID = {};
  $scope.qualityCacheByMessageID = {};

  function parseNumber(v, fallback) {
    var n = parseFloat(v);
    return isNaN(n) ? fallback : n;
  }
  function clamp(v, min, max) {
    if(v < min) { return min; }
    if(v > max) { return max; }
    return v;
  }

  if(typeof(Storage) !== "undefined") {
      $scope.itemsPerPage = parseInt(localStorage.getItem("itemsPerPage"), 10)
      if(!$scope.itemsPerPage) {
        $scope.itemsPerPage = 50;
        localStorage.setItem("itemsPerPage", 50)
      }
      var savedMode = localStorage.getItem("mailhogViewMode");
      if(savedMode === "columns" || savedMode === "stacked") {
        $scope.viewMode = savedMode;
      }
      $scope.columnsListWidth = clamp(parseNumber(localStorage.getItem("mailhogViewColumnsWidth"), 46), 28, 72);
      $scope.stackedListHeight = clamp(parseNumber(localStorage.getItem("mailhogViewStackedHeight"), 48), 25, 75);
      var savedFolder = localStorage.getItem("mailhogSelectedFolder");
      if(savedFolder !== null) {
        $scope.pendingSavedFolderSelection = savedFolder;
      }
      $scope.showFavoritesOnly = localStorage.getItem("mailhogShowFavoritesOnly") === "1";
      var savedSortOrder = localStorage.getItem("mailhogSortOrder");
      if(savedSortOrder === "asc" || savedSortOrder === "desc") {
        $scope.sortOrder = savedSortOrder;
      }
      try {
        var savedFavoriteState = localStorage.getItem("mailhogFavoriteStateByMessageID");
        if(savedFavoriteState) {
          $scope.favoriteStateByMessageID = JSON.parse(savedFavoriteState) || {};
        }
      } catch(e) {
        $scope.favoriteStateByMessageID = {};
      }
      try {
        var savedReadState = localStorage.getItem("mailhogReadStateByMessageID");
        if(savedReadState) {
          $scope.readStateByMessageID = JSON.parse(savedReadState) || {};
        }
      } catch(e) {
        $scope.readStateByMessageID = {};
      }
  }

  $scope.startMessages = 0
  $scope.countMessages = 0
  $scope.totalMessages = 0

  $scope.startSearchMessages = 0
  $scope.countSearchMessages = 0
  $scope.totalSearchMessages = 0

  $scope.jim = null

  $scope.smtpmech = "NONE"
  $scope.selectedOutgoingSMTP = ""
  $scope.saveSMTPServer = false;
  $scope.selectedFolder = "";
  $scope.folderPendingDelete = "";
  $scope.folderPendingDeleteIsInbox = false;
  $scope.folders = [];
  $scope.showSettings = false;
  $scope.settingsLoading = false;
  $scope.settingsSaving = false;
  $scope.settingsStatus = "";
  $scope.settingsError = "";
  $scope.settingsForm = {
    retentionDays: 10,
    storageType: "maildir",
    maildirPath: "",
    defaultFolders: [],
    forceDefaultInboxOnly: false
  };
  $scope.settingsDefaultFolderInput = "";
  $scope.settingsRequiresRestart = false;
  $scope.settingsLoadedSnapshot = null;
  $scope.settingsDirty = false;
  $scope.messages = [];
  $scope.searchMessages = [];

  $scope.getFolderFromMessage = function(message) {
    if(!message || !message.Content || !message.Content.Headers) {
      return "";
    }

    for(var key in message.Content.Headers) {
      if(key && key.toLowerCase() === "x-mailhogplus-folder") {
        var values = message.Content.Headers[key];
        if(values && values.length > 0 && values[0]) {
          return values[0].trim();
        }
      }
    }
    return "";
  }

  $scope.normalizeFolderName = function(folderName) {
    if(!folderName) {
      return "";
    }
    return folderName.trim().toLowerCase();
  }

  $scope.getFolderSelectionKey = function(folderName) {
    var normalizedFolder = $scope.normalizeFolderName(folderName);
    if(normalizedFolder.length === 0) {
      return "inbox";
    }
    return "folder:" + normalizedFolder;
  }

  $scope.rememberSelectedMessageForCurrentFolder = function(messageID) {
    var key = $scope.getFolderSelectionKey($scope.selectedFolder);
    if(!messageID || messageID.length === 0) {
      delete $scope.lastSelectedMessageByFolder[key];
      return;
    }
    $scope.lastSelectedMessageByFolder[key] = messageID;
  }

  $scope.getRememberedMessageIDForFolder = function(folderName) {
    var key = $scope.getFolderSelectionKey(folderName);
    return $scope.lastSelectedMessageByFolder[key] || null;
  }

  $scope.forgetRememberedMessageID = function(messageID) {
    if(!messageID) {
      return;
    }
    for(var key in $scope.lastSelectedMessageByFolder) {
      if($scope.lastSelectedMessageByFolder[key] === messageID) {
        delete $scope.lastSelectedMessageByFolder[key];
      }
    }
  }

  $scope.queueFolderSelectionRestore = function(folderName) {
    $scope.restoreMessageIDOnNextRefresh = $scope.getRememberedMessageIDForFolder(folderName);
    $scope.autoSelectFirstOnNextRefresh = true;
  }

  $scope.messageMatchesSelectedFolder = function(message) {
    var folder = $scope.normalizeFolderName($scope.getFolderFromMessage(message));
    var selectedFolder = $scope.normalizeFolderName($scope.selectedFolder);
    if(selectedFolder.length > 0) {
      return folder === selectedFolder;
    }
    return folder.length === 0;
  }

  $scope.sortFolders = function() {
    $scope.folders.sort(function(a, b) {
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
  }

  $scope.normalizeSortOrder = function(order) {
    return (order || "").toLowerCase() === "asc" ? "asc" : "desc";
  }

  $scope.setSortOrder = function(order) {
    var normalized = $scope.normalizeSortOrder(order);
    if($scope.sortOrder === normalized) {
      return;
    }
    $scope.sortOrder = normalized;
    $scope.startIndex = 0;
    $scope.startMessages = 0;
    $scope.startSearchMessages = 0;
    if(typeof(Storage) !== "undefined") {
      localStorage.setItem("mailhogSortOrder", $scope.sortOrder);
    }
    $scope.refresh();
  }

  $scope.getPagingState = function() {
    if($scope.searching) {
      return {
        start: $scope.startSearchMessages || 0,
        count: $scope.countSearchMessages || 0,
        total: $scope.totalSearchMessages || 0
      };
    }
    return {
      start: $scope.startMessages || 0,
      count: $scope.countMessages || 0,
      total: $scope.totalMessages || 0
    };
  }

  $scope.canShowNewer = function() {
    var paging = $scope.getPagingState();
    if($scope.sortOrder === "asc") {
      return (paging.start + paging.count) < paging.total;
    }
    return paging.start > 0;
  }

  $scope.canShowOlder = function() {
    var paging = $scope.getPagingState();
    if($scope.sortOrder === "asc") {
      return paging.start > 0;
    }
    return (paging.start + paging.count) < paging.total;
  }

  $scope.bumpFolderCount = function(folderName) {
    var normalizedFolderName = $scope.normalizeFolderName(folderName);
    if(normalizedFolderName.length === 0) {
      return;
    }
    for(var i = 0; i < $scope.folders.length; i++) {
      if($scope.normalizeFolderName($scope.folders[i].name) === normalizedFolderName) {
        $scope.folders[i].count++;
        return;
      }
    }
    $scope.folders.push({ name: folderName.trim(), count: 1 });
    $scope.sortFolders();
  }

  $scope.refreshFolders = function() {
    $http.get($scope.host + 'api/v2/folders').success(function(data) {
      $scope.folders = data.items || [];
      $scope.sortFolders();
      if($scope.pendingSavedFolderSelection !== null) {
        var desiredFolder = ($scope.pendingSavedFolderSelection || "").trim();
        $scope.pendingSavedFolderSelection = null;
        if(desiredFolder.length > 0) {
          var normalizedDesiredFolder = $scope.normalizeFolderName(desiredFolder);
          var matchingFolderName = "";
          for(var i = 0; i < $scope.folders.length; i++) {
            if($scope.normalizeFolderName($scope.folders[i].name) === normalizedDesiredFolder) {
              matchingFolderName = $scope.folders[i].name;
              break;
            }
          }

          if(matchingFolderName.length > 0) {
            if(!$scope.showSettings &&
               !$scope.searching &&
               $scope.normalizeFolderName($scope.selectedFolder) !== $scope.normalizeFolderName(matchingFolderName)) {
              $scope.selectFolder(matchingFolderName);
              return;
            }
          } else {
            $scope.setSavedFolderPreference("");
          }
        }
      }
    });
  }

  $scope.setSavedFolderPreference = function(folderName) {
    if(typeof(Storage) === "undefined") {
      return;
    }
    localStorage.setItem("mailhogSelectedFolder", (folderName || "").trim());
  }

  $scope.persistFavoriteState = function() {
    if(typeof(Storage) === "undefined") {
      return;
    }
    localStorage.setItem("mailhogFavoriteStateByMessageID", JSON.stringify($scope.favoriteStateByMessageID || {}));
  }

  $scope.persistReadState = function() {
    if(typeof(Storage) === "undefined") {
      return;
    }
    localStorage.setItem("mailhogReadStateByMessageID", JSON.stringify($scope.readStateByMessageID || {}));
  }

  $scope.getMimeHeaderValueFromPart = function(part, headerName) {
    if(!part || !part.Headers || !headerName) {
      return "";
    }
    var targetHeader = headerName.toLowerCase();
    for(var key in part.Headers) {
      if(key && key.toLowerCase() === targetHeader) {
        var values = part.Headers[key];
        if(values && values.length > 0 && values[0]) {
          return values[0];
        }
      }
    }
    return "";
  }

  $scope.extractHeaderParam = function(headerValue, paramName) {
    if(!headerValue || !paramName) {
      return "";
    }
    var escapedParam = paramName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    var quotedMatch = new RegExp("(?:^|;)\\s*" + escapedParam + "\\*?\\s*=\\s*\"([^\"]+)\"", "i").exec(headerValue);
    if(quotedMatch && quotedMatch[1]) {
      return quotedMatch[1].trim();
    }
    var plainMatch = new RegExp("(?:^|;)\\s*" + escapedParam + "\\*?\\s*=\\s*([^;]+)", "i").exec(headerValue);
    if(plainMatch && plainMatch[1]) {
      return plainMatch[1].trim();
    }
    return "";
  }

  $scope.isAttachmentPart = function(part) {
    if(!part) {
      return false;
    }
    var disposition = $scope.getMimeHeaderValueFromPart(part, "Content-Disposition");
    var dispositionLower = disposition.toLowerCase();
    var contentType = $scope.getMimeHeaderValueFromPart(part, "Content-Type");
    var fileName = $scope.extractHeaderParam(disposition, "filename");
    if(fileName.length === 0) {
      fileName = $scope.extractHeaderParam(contentType, "name");
    }

    if(dispositionLower.indexOf("attachment") >= 0) {
      return true;
    }
    if(fileName.length > 0 && dispositionLower.indexOf("inline") < 0) {
      return true;
    }
    return false;
  }

  $scope.collectAttachmentsFromMime = function(mimeBody, pathPrefix, attachments) {
    if(!mimeBody || !mimeBody.Parts || !mimeBody.Parts.length) {
      return;
    }
    for(var i = 0; i < mimeBody.Parts.length; i++) {
      var part = mimeBody.Parts[i];
      var path = pathPrefix.length > 0 ? (pathPrefix + "." + i) : ("" + i);
      if($scope.isAttachmentPart(part)) {
        var disposition = $scope.getMimeHeaderValueFromPart(part, "Content-Disposition");
        var contentType = $scope.getMimeHeaderValueFromPart(part, "Content-Type") || "application/octet-stream";
        var fileName = $scope.extractHeaderParam(disposition, "filename");
        if(fileName.length === 0) {
          fileName = $scope.extractHeaderParam(contentType, "name");
        }
        if(fileName.length === 0) {
          fileName = "attachment-" + (attachments.length + 1);
        }
        attachments.push({
          path: path,
          fileName: $scope.tryDecodeMime(fileName),
          contentType: $scope.tryDecodeMime(contentType),
          size: part.Size || (part.Body ? part.Body.length : 0)
        });
      }
      if(part && part.MIME && part.MIME.Parts && part.MIME.Parts.length) {
        $scope.collectAttachmentsFromMime(part.MIME, path, attachments);
      }
    }
  }

  $scope.getMessageAttachments = function(message) {
    if(!message || !message.ID) {
      return [];
    }
    var messageID = message.ID;
    var hasMime = !!(message.MIME || (message.Content && message.Content.MIME));
    var signature = hasMime ? "mime" : "none";
    var cached = $scope.attachmentCacheByMessageID[messageID];
    if(cached && cached.signature === signature) {
      return cached.items;
    }

    var attachments = [];
    var mimeBody = message.MIME || (message.Content ? message.Content.MIME : null);
    if(mimeBody) {
      $scope.collectAttachmentsFromMime(mimeBody, "", attachments);
    }
    $scope.attachmentCacheByMessageID[messageID] = {
      signature: signature,
      items: attachments
    };
    return attachments;
  }

  $scope.downloadAllAttachments = function(message) {
    if(!message || !message.ID) {
      return;
    }
    var attachments = $scope.getMessageAttachments(message);
    for(var i = 0; i < attachments.length; i++) {
      (function(path, idx) {
        window.setTimeout(function() {
          var link = document.createElement("a");
          link.href = $scope.host + "api/v1/messages/" + message.ID + "/mime/part/" + path + "/download";
          link.target = "_blank";
          link.rel = "noopener";
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
        }, idx * 140);
      })(attachments[i].path, i);
    }
  }

  $scope.loadEmailQuality = function(message) {
    if(!message || !message.ID) {
      return;
    }
    var messageID = message.ID;
    if($scope.qualityCacheByMessageID[messageID]) {
      message.quality = $scope.qualityCacheByMessageID[messageID];
      message.qualityLoading = false;
      message.qualityError = "";
    } else {
      message.qualityLoading = true;
      message.qualityError = "";
    }

    $http.get($scope.host + 'api/v2/messages/' + encodeURIComponent(messageID) + '/quality').success(function(data) {
      $scope.qualityCacheByMessageID[messageID] = data;
      message.quality = data;
      message.qualityLoading = false;
      if($scope.preview && $scope.preview.ID === messageID) {
        $scope.preview.quality = data;
        $scope.preview.qualityLoading = false;
        $scope.preview.qualityError = "";
        $timeout(function() {
          $scope.resizePreview();
        }, 0);
      }
    }).error(function() {
      message.qualityLoading = false;
      message.qualityError = "Email quality check is unavailable.";
      if($scope.preview && $scope.preview.ID === messageID) {
        $scope.preview.qualityLoading = false;
        $scope.preview.qualityError = message.qualityError;
      }
    });
  }

  $scope.qualityClass = function(result) {
    if(!result || !result.ragStatus) {
      return "";
    }
    return "quality-" + result.ragStatus.toLowerCase();
  }

  $scope.qualityScoreText = function(result) {
    if(!result || typeof result.score === "undefined") {
      return "";
    }
    return parseFloat(result.score).toFixed(1);
  }

  $scope.getQualityHintsBySeverity = function(result, severity) {
    if(!result || !result.hints || !severity) {
      return [];
    }
    var matches = [];
    for(var i = 0; i < result.hints.length; i++) {
      if(result.hints[i].severity === severity) {
        matches.push(result.hints[i]);
      }
    }
    return matches;
  }

  $scope.hasQualityIssues = function(result) {
    if(!result) {
      return false;
    }
    return (result.criticalIssues && result.criticalIssues.length > 0) || (result.hints && result.hints.length > 0);
  }

  $scope.isMessageFavorite = function(message) {
    if(!message || !message.ID) {
      return false;
    }
    return !!$scope.favoriteStateByMessageID[message.ID];
  }

  $scope.toggleFavorite = function(message, $event) {
    if($event) {
      $event.preventDefault();
      $event.stopPropagation();
    }
    if(!message || !message.ID) {
      return;
    }
    if($scope.favoriteStateByMessageID[message.ID]) {
      delete $scope.favoriteStateByMessageID[message.ID];
    } else {
      $scope.favoriteStateByMessageID[message.ID] = true;
    }
    $scope.persistFavoriteState();
    $scope.syncSelectionWithVisibleMessages();
  }

  $scope.toggleFavoriteFilter = function() {
    $scope.showFavoritesOnly = !$scope.showFavoritesOnly;
    if(typeof(Storage) !== "undefined") {
      localStorage.setItem("mailhogShowFavoritesOnly", $scope.showFavoritesOnly ? "1" : "0");
    }
    $scope.syncSelectionWithVisibleMessages();
  }

  $scope.setMessageReadStateByID = function(messageID, isRead) {
    if(!messageID) {
      return;
    }
    if(isRead) {
      $scope.readStateByMessageID[messageID] = true;
    } else {
      delete $scope.readStateByMessageID[messageID];
    }
    $scope.persistReadState();
  }

  $scope.isMessageRead = function(message) {
    if(!message || !message.ID) {
      return false;
    }
    return !!$scope.readStateByMessageID[message.ID];
  }

  $scope.toggleReadState = function(message, $event) {
    if($event) {
      $event.preventDefault();
      $event.stopPropagation();
    }
    if(!message || !message.ID) {
      return;
    }
    $scope.setMessageReadStateByID(message.ID, !$scope.isMessageRead(message));
  }

  $scope.getCurrentMessageCollection = function() {
    return $scope.searching ? ($scope.searchMessages || []) : ($scope.messages || []);
  }

  $scope.getVisibleMessages = function() {
    var source = $scope.getCurrentMessageCollection();
    if(!$scope.showFavoritesOnly) {
      return source;
    }
    var filtered = [];
    for(var i = 0; i < source.length; i++) {
      if($scope.isMessageFavorite(source[i])) {
        filtered.push(source[i]);
      }
    }
    return filtered;
  }

  $scope.getSelectedVisibleMessage = function() {
    if(!$scope.selectedMessageID) {
      return null;
    }
    var visible = $scope.getVisibleMessages();
    for(var i = 0; i < visible.length; i++) {
      if(visible[i].ID === $scope.selectedMessageID) {
        return visible[i];
      }
    }
    return null;
  }

  $scope.syncSelectionWithVisibleMessages = function() {
    if($scope.showSettings) {
      return;
    }
    var visible = $scope.getVisibleMessages();
    if(!visible || visible.length === 0) {
      $scope.preview = null;
      $scope.selectedMessageID = null;
      $scope.previewAllHeaders = false;
      return;
    }
    var selected = $scope.getSelectedVisibleMessage();
    if(!selected) {
      $scope.selectMessage(visible[0]);
    }
  }

  $scope.moveSelectionByOffset = function(offset) {
    var visible = $scope.getVisibleMessages();
    if(!visible || visible.length === 0) {
      return;
    }

    if(!$scope.selectedMessageID) {
      $scope.selectMessage(offset < 0 ? visible[visible.length - 1] : visible[0]);
      return;
    }

    var selectedIndex = -1;
    for(var i = 0; i < visible.length; i++) {
      if(visible[i].ID === $scope.selectedMessageID) {
        selectedIndex = i;
        break;
      }
    }

    if(selectedIndex < 0) {
      $scope.selectMessage(offset < 0 ? visible[visible.length - 1] : visible[0]);
      return;
    }

    var nextIndex = clamp(selectedIndex + offset, 0, visible.length - 1);
    if(nextIndex !== selectedIndex) {
      $scope.selectMessage(visible[nextIndex]);
    }
  }

  $scope.handleKeyboardShortcuts = function(event) {
    if($scope.showSettings) {
      return;
    }
    if($('.modal.in:visible').length > 0) {
      return;
    }
    var target = event.target || event.srcElement;
    if(target) {
      var tagName = (target.tagName || "").toLowerCase();
      if(tagName === "input" || tagName === "textarea" || tagName === "select" || target.isContentEditable) {
        return;
      }
    }

    var key = event.which || event.keyCode;

    if(key === 38 || key === 40 || key === 32) {
      event.preventDefault();
    } else {
      return;
    }

    $scope.$applyAsync(function() {
      if(key === 38) {
        $scope.moveSelectionByOffset(-1);
      } else if(key === 40) {
        $scope.moveSelectionByOffset(1);
      } else if(key === 32) {
        var selectedMessage = $scope.getSelectedVisibleMessage();
        if(selectedMessage) {
          $scope.toggleReadState(selectedMessage);
        }
      }
    });
  }
  $document.on("keydown", $scope.handleKeyboardShortcuts);
  $scope.$on("$destroy", function() {
    $document.off("keydown", $scope.handleKeyboardShortcuts);
  });

  $scope.selectInbox = function() {
    $scope.showSettings = false;
    $scope.preview = null;
    $scope.previewAllHeaders = false;
    $scope.selectedMessageID = null;
    $scope.queueFolderSelectionRestore("");
    $scope.selectedFolder = "";
    $scope.startIndex = 0;
    $scope.startMessages = 0;
    $scope.searching = false;
    $scope.setSavedFolderPreference("");
    $scope.refresh();
  }

  $scope.selectFolder = function(folderName) {
    $scope.showSettings = false;
    $scope.preview = null;
    $scope.previewAllHeaders = false;
    $scope.selectedMessageID = null;
    $scope.queueFolderSelectionRestore(folderName || "");
    $scope.selectedFolder = folderName || "";
    $scope.startIndex = 0;
    $scope.startMessages = 0;
    $scope.searching = false;
    $scope.setSavedFolderPreference($scope.selectedFolder);
    $scope.refresh();
  }

  $scope.getJim = function() {
    var url = $scope.host + 'api/v2/jim'
    $http.get(url).success(function(data) {
      $scope.jim = data
    }).error(function() {
      $scope.jim = null
    })
  }
  $scope.getJim()
  $scope.refreshFolders()

  $scope.enableJim = function() {
    var url = $scope.host + 'api/v2/jim'
    $http.post(url).success(function(data) {
      $scope.getJim()
    })
  }
  $scope.disableJim = function() {
    var url = $scope.host + 'api/v2/jim'
    $http.delete(url).success(function(data) {
      $scope.getJim()
    })
  }

  $(function() {
    $scope.openStream();
    if(typeof(Notification) !== "undefined") {
      Notification.requestPermission();
    }
  });

  $scope.getMoment = function(a) {
    return moment(a)
  }

  $scope.connectionSettings = {};

  $scope.buildConnectionSettings = function() {
    var uiOrigin = location.protocol + '//' + location.hostname + (location.port ? ':' + location.port : '');
    var apiBase = $scope.host && $scope.host.length > 0 ? $scope.host : (uiOrigin + location.pathname);
    if(apiBase.charAt(apiBase.length - 1) !== '/') {
      apiBase += '/';
    }

    var parser = document.createElement('a');
    parser.href = apiBase;
    var apiHost = parser.hostname || location.hostname;
    var apiPort = parser.port || (parser.protocol === 'https:' ? '443' : '80');
    var wsProtocol = parser.protocol === 'https:' ? 'wss://' : 'ws://';
    var wsPort = parser.port ? ':' + parser.port : '';

    $scope.connectionSettings = {
      uiOrigin: uiOrigin,
      apiBase: apiBase,
      apiHost: apiHost,
      apiPort: apiPort,
      websocketEndpoint: wsProtocol + apiHost + wsPort + '/api/v2/websocket',
      smtpHost: apiHost,
      smtpPort: '1025',
      pop3Port: '1100'
    };
  }

  $scope.openAboutModal = function() {
    $('#about-mailhogplus-modal').modal('show');
  }

  // Backward compatibility for existing template hooks.
  $scope.openConnectionModal = $scope.openAboutModal;

  $scope.sanitizeDefaultFolders = function(folders) {
    var cleaned = [];
    var seen = {};
    if(!folders || !folders.length) {
      return cleaned;
    }

    for(var i = 0; i < folders.length; i++) {
      var rawValue = folders[i];
      var folderName = "";
      if(typeof rawValue === "string") {
        folderName = rawValue.trim();
      } else if(rawValue !== null && rawValue !== undefined) {
        folderName = ("" + rawValue).trim();
      }
      var normalizedName = $scope.normalizeFolderName(folderName);
      if(normalizedName.length === 0 || seen[normalizedName]) {
        continue;
      }
      seen[normalizedName] = true;
      cleaned.push(folderName);
    }
    return cleaned;
  }

  $scope.addDefaultFolder = function(inputValue) {
    var folderName = (inputValue || $scope.settingsDefaultFolderInput || "").trim();
    if(folderName.length === 0) {
      var inputElement = document.getElementById('settings-default-folder-input');
      if(inputElement && inputElement.value) {
        folderName = inputElement.value.trim();
      }
    }
    if(folderName.length === 0) {
      return;
    }

    var existing = $scope.sanitizeDefaultFolders($scope.settingsForm.defaultFolders);
    var normalizedNew = $scope.normalizeFolderName(folderName);
    for(var i = 0; i < existing.length; i++) {
      if($scope.normalizeFolderName(existing[i]) === normalizedNew) {
        $scope.settingsForm.defaultFolders = existing;
        $scope.settingsDefaultFolderInput = "";
        return;
      }
    }

    existing.push(folderName);
    $scope.settingsForm.defaultFolders = existing.slice(0);
    $scope.settingsDefaultFolderInput = "";
    var settingsFolderInput = document.getElementById('settings-default-folder-input');
    if(settingsFolderInput) {
      settingsFolderInput.value = "";
    }
  }

  $scope.removeDefaultFolder = function(folderName) {
    var normalizedTarget = $scope.normalizeFolderName(folderName);
    var existing = $scope.sanitizeDefaultFolders($scope.settingsForm.defaultFolders);
    var next = [];
    for(var i = 0; i < existing.length; i++) {
      if($scope.normalizeFolderName(existing[i]) !== normalizedTarget) {
        next.push(existing[i]);
      }
    }
    $scope.settingsForm.defaultFolders = next;
  }

  $scope.isDefaultFolder = function(folderName) {
    var normalizedFolder = $scope.normalizeFolderName(folderName);
    if(normalizedFolder.length === 0) {
      return false;
    }
    var defaults = $scope.sanitizeDefaultFolders($scope.settingsForm.defaultFolders);
    for(var i = 0; i < defaults.length; i++) {
      if($scope.normalizeFolderName(defaults[i]) === normalizedFolder) {
        return true;
      }
    }
    return false;
  }

  $scope.getSettingsSnapshot = function() {
    var retentionDays = parseInt($scope.settingsForm.retentionDays, 10);
    if(isNaN(retentionDays) || retentionDays < 0) {
      retentionDays = 0;
    }
    return {
      retentionDays: retentionDays,
      storageType: ($scope.settingsForm.storageType || "").toLowerCase(),
      defaultFolders: $scope.sanitizeDefaultFolders($scope.settingsForm.defaultFolders),
      forceDefaultInboxOnly: !!$scope.settingsForm.forceDefaultInboxOnly
    };
  }

  $scope.captureSettingsSnapshot = function() {
    $scope.settingsLoadedSnapshot = angular.toJson($scope.getSettingsSnapshot());
    $scope.settingsDirty = false;
  }

  $scope.updateSettingsDirtyState = function() {
    if(!$scope.settingsLoadedSnapshot) {
      $scope.settingsDirty = false;
      return;
    }
    var isDirty = angular.toJson($scope.getSettingsSnapshot()) !== $scope.settingsLoadedSnapshot;
    if(isDirty && $scope.settingsStatus) {
      $scope.settingsStatus = "";
    }
    $scope.settingsDirty = isDirty;
  }

  $scope.hasSettingsChanges = function() {
    return !!$scope.settingsDirty;
  }

  $scope.discardSettingsChanges = function() {
    if($scope.settingsLoading || $scope.settingsSaving || !$scope.hasSettingsChanges()) {
      return;
    }
    $scope.fetchSettings();
  }

  $scope.$watch(function() {
    return angular.toJson($scope.getSettingsSnapshot());
  }, function() {
    $scope.updateSettingsDirtyState();
  });

  $scope.setViewMode = function(mode) {
    if(mode !== "columns" && mode !== "stacked") {
      return;
    }
    $scope.viewMode = mode;
    if(typeof(Storage) !== "undefined") {
      localStorage.setItem("mailhogViewMode", mode);
    }
    $timeout(function() {
      $scope.resizePreview();
    }, 0);
  }

  $scope.startPaneResize = function(event) {
    event.preventDefault();
    var workspace = document.getElementById('mail-workspace');
    if(!workspace) {
      return;
    }

    var rect = workspace.getBoundingClientRect();
    var startX = event.pageX;
    var startY = event.pageY;
    var startColumns = $scope.columnsListWidth;
    var startStacked = $scope.stackedListHeight;
    var isColumns = $scope.viewMode === "columns";

    var onMove = function(e) {
      if(isColumns) {
        var deltaX = e.pageX - startX;
        var nextWidth = ((startColumns / 100.0 * rect.width) + deltaX) / rect.width * 100.0;
        nextWidth = clamp(nextWidth, 28, 72);
        $scope.$applyAsync(function() {
          $scope.columnsListWidth = nextWidth;
        });
      } else {
        var deltaY = e.pageY - startY;
        var nextHeight = ((startStacked / 100.0 * rect.height) + deltaY) / rect.height * 100.0;
        nextHeight = clamp(nextHeight, 25, 75);
        $scope.$applyAsync(function() {
          $scope.stackedListHeight = nextHeight;
        });
      }
    };

    var onUp = function() {
      $document.off("mousemove", onMove);
      $document.off("mouseup", onUp);
      if(typeof(Storage) !== "undefined") {
        localStorage.setItem("mailhogViewColumnsWidth", $scope.columnsListWidth);
        localStorage.setItem("mailhogViewStackedHeight", $scope.stackedListHeight);
      }
      $scope.$applyAsync(function() {
        $scope.resizePreview();
      });
    };

    $document.on("mousemove", onMove);
    $document.on("mouseup", onUp);
  }

  $scope.fetchSettings = function() {
    $scope.settingsLoading = true;
    $scope.settingsError = "";
    $scope.settingsStatus = "";
    $scope.settingsLoadedSnapshot = null;
    $scope.settingsDirty = false;
    $http.get($scope.host + 'api/v2/settings').success(function(data) {
      $scope.settingsForm.retentionDays = data.retentionDays || 10;
      $scope.settingsForm.storageType = data.storageType || "maildir";
      $scope.settingsForm.maildirPath = data.maildirPath || "";
      $scope.settingsForm.defaultFolders = $scope.sanitizeDefaultFolders(data.defaultFolders || []);
      $scope.settingsForm.forceDefaultInboxOnly = data.forceDefaultInboxOnly === true;
      $scope.settingsDefaultFolderInput = "";
      $scope.settingsRequiresRestart = !!data.requiresRestart;
      $scope.settingsLoading = false;
      $scope.captureSettingsSnapshot();
    }).error(function() {
      $scope.settingsLoading = false;
      $scope.settingsError = "Unable to load settings.";
      $scope.settingsLoadedSnapshot = null;
      $scope.settingsDirty = false;
    });
  }

  $scope.openSettings = function() {
    $scope.preview = null;
    $scope.selectedMessageID = null;
    $scope.searching = false;
    $scope.showSettings = true;
    $scope.buildConnectionSettings();
    $scope.fetchSettings();
  }

  $scope.saveSettings = function() {
    var retentionDays = parseInt($scope.settingsForm.retentionDays, 10);
    if(!retentionDays || retentionDays <= 0) {
      $scope.settingsError = "Retention days must be greater than 0.";
      $scope.settingsStatus = "";
      return;
    }
    if(!$scope.hasSettingsChanges()) {
      $scope.settingsStatus = "No changes to save.";
      $scope.settingsError = "";
      return;
    }
    var defaultFolders = $scope.sanitizeDefaultFolders($scope.settingsForm.defaultFolders);

    $scope.settingsSaving = true;
    $scope.settingsError = "";
    $scope.settingsStatus = "";
    $http.put($scope.host + 'api/v2/settings', {
      retentionDays: retentionDays,
      storageType: $scope.settingsForm.storageType,
      defaultFolders: defaultFolders,
      forceDefaultInboxOnly: !!$scope.settingsForm.forceDefaultInboxOnly
    }).success(function(data) {
      $scope.settingsForm.retentionDays = data.retentionDays || retentionDays;
      $scope.settingsForm.storageType = data.storageType || $scope.settingsForm.storageType;
      $scope.settingsForm.maildirPath = data.maildirPath || $scope.settingsForm.maildirPath;
      $scope.settingsForm.defaultFolders = $scope.sanitizeDefaultFolders(data.defaultFolders || defaultFolders);
      $scope.settingsForm.forceDefaultInboxOnly = data.forceDefaultInboxOnly === true;
      $scope.settingsDefaultFolderInput = "";
      $scope.settingsRequiresRestart = !!data.requiresRestart;
      $scope.settingsSaving = false;
      $scope.captureSettingsSnapshot();
      $scope.settingsStatus = $scope.settingsRequiresRestart ? "Settings saved. Restart required for storage mode change." : "Settings saved.";
      $scope.refresh();
    }).error(function() {
      $scope.settingsSaving = false;
      $scope.settingsError = "Unable to save settings.";
    });
  }

  $scope.backToInbox = function() {
    $scope.showSettings = false;
    $scope.searching = false;
    $scope.startIndex = 0;
    $scope.refresh();
  }
  $scope.closePreview = function() {
    $scope.preview = null;
    $scope.selectedMessageID = null;
    $scope.previewAllHeaders = false;
  }
  $scope.backToInboxFirst = function() {
    $scope.selectInbox();
  }

  $scope.toggleStream = function() {
    $scope.source == null ? $scope.openStream() : $scope.closeStream();
  }
  $scope.openStream = function() {
    var host = $scope.host.replace(/^http/, 'ws') ||
               (location.protocol.replace(/^http/, 'ws') + '//' + location.hostname + (location.port ? ':' + location.port : '') + location.pathname);
    $scope.source = new WebSocket(host + 'api/v2/websocket');
    $scope.source.addEventListener('message', function(e) {
      $scope.$apply(function() {
        var message = JSON.parse(e.data);
        var messageFolder = $scope.getFolderFromMessage(message);
        $scope.bumpFolderCount(messageFolder);
        if(typeof(Notification) !== "undefined") {
          $scope.createNotification(message);
        }

        if(!$scope.messageMatchesSelectedFolder(message)) {
          return;
        }

        $scope.totalMessages++;
        if($scope.sortOrder === "asc") {
          if($scope.startIndex > 0) {
            return;
          }
          if($scope.countMessages < $scope.itemsPerPage) {
            $scope.countMessages++;
            $scope.messages.push(message);
          }
          return;
        }

        if ($scope.startIndex > 0) {
          $scope.startIndex++;
          $scope.startMessages++;
          return
        }
        if ($scope.countMessages < $scope.itemsPerPage) {
          $scope.countMessages++;
        }
        $scope.messages.unshift(message);
        while($scope.messages.length > $scope.itemsPerPage) {
          $scope.messages.pop();
        }
      });
    }, false);
    $scope.source.addEventListener('open', function(e) {
      $scope.$apply(function() {
        $scope.hasEventSource = true;
      });
    }, false);
    $scope.source.addEventListener('error', function(e) {
      //if(e.readyState == EventSource.CLOSED) {
        $scope.$apply(function() {
          $scope.hasEventSource = false;
        });
      //}
    }, false);
  }
  $scope.closeStream = function() {
    $scope.source.close();
    $scope.source = null;
    $scope.hasEventSource = false;
  }

  $scope.createNotification = function(message) {
    var title = "Mail from " + $scope.getSender(message);
    var options = {
      body: $scope.tryDecodeMime(message.Content.Headers["Subject"][0]),
      tag: "MailHogPlus",
      icon: "images/mailhogplus_app_icon.png"
    };
    var notification = new Notification(title, options);
    notification.addEventListener('click', function(e) {
      $scope.selectMessage(message);
      window.focus();
      notification.close();
    });
  }

  $scope.tryDecodeMime = function(str) {
    return unescapeFromMime(str)
  }

  $scope.resizePreview = function() {
    var preview = $('.mail-preview-pane .preview:visible');
    if(preview.length === 0) {
      return;
    }
    var tabContent = preview.find('.tab-content');
    if(tabContent.length === 0) {
      return;
    }
    var available = preview.innerHeight() - tabContent.position().top - 12;
    if(available > 120) {
      tabContent.height(available);
      tabContent.find('.tab-pane').height(available);
    }
  }

  $scope.getHeaderValue = function(message, headerName) {
    if(!message || !message.Content || !message.Content.Headers || !headerName) {
      return "";
    }
    var targetHeader = headerName.toLowerCase();
    for(var key in message.Content.Headers) {
      if(key && key.toLowerCase() === targetHeader) {
        var values = message.Content.Headers[key];
        if(values && values.length > 0 && values[0]) {
          return values[0];
        }
        return "";
      }
    }
    return "";
  }

  $scope.getSender = function(message) {
    var fromHeader = $scope.getHeaderValue(message, "From");
    if(fromHeader.length > 0) {
      var decodedFrom = $scope.tryDecodeMime(fromHeader);
      var displayName = $scope.getDisplayName(decodedFrom);
      if(displayName && !/^\s*\{\{.*\}\}\s*$/.test(displayName)) {
        return displayName.trim();
      }
    }

    if(message && message.From && message.From.Mailbox && message.From.Domain) {
      return message.From.Mailbox + "@" + message.From.Domain;
    }

    return "";
  }

  $scope.getDisplayName = function(value) {
    if(!value) { return ""; }

    var res = value.match(/(.*)\<(.*)\>/);

    if(res) {
      if(res[1].trim().length > 0) {
        return res[1].trim();
      }
      return res[2];
    }
    return value
  }

  $scope.startEvent = function(name, args, glyphicon) {
    var eID = guid();
    //console.log("Starting event '" + name + "' with id '" + eID + "'")
    var e = {
      id: eID,
      name: name,
      started: new Date(),
      complete: false,
      failed: false,
      args: args,
      glyphicon: glyphicon,
      getClass: function() {
        // FIXME bit nasty
        if(this.failed) {
          return "bg-danger"
        }
        if(this.complete) {
          return "bg-success"
        }
        return "bg-warning"; // pending
      },
      done: function() {
        //delete $scope.eventsPending[eID]
        var e = this;
        e.complete = true;
        $scope.eventDone++;
        if(this.failed) {
          // console.log("Failed event '" + e.name + "' with id '" + eID + "'")
        } else {
          // console.log("Completed event '" + e.name + "' with id '" + eID + "'")
          $timeout(function() {
            e.remove();
          }, 10000);
        }
      },
      fail: function() {
        $scope.eventFailed++;
        this.failed = true;
        this.done();
      },
      remove: function() {
        // console.log("Deleted event '" + e.name + "' with id '" + eID + "'")
        if(e.failed) {
          $scope.eventFailed--;
        }
        delete $scope.eventsPending[eID];
        $scope.eventDone--;
        $scope.eventCount--;
        return false;
      }
    };
    $scope.eventsPending[eID] = e;
    $scope.eventCount++;
    return e;
  }

  $scope.messagesDisplayed = function() {
    return $('.messages .msglist-message').length
  }

  $scope.refresh = function() {
    if ($scope.searching) {
      return $scope.refreshSearch();
    }
    var e = $scope.startEvent("Loading messages", null, "glyphicon-download");
    var url = $scope.host + 'api/v2/messages'
    if($scope.startIndex > 0) {
      url += "?start=" + $scope.startIndex + "&limit=" + $scope.itemsPerPage;
    } else {
      url += "?limit=" + $scope.itemsPerPage;
    }
    if($scope.selectedFolder && $scope.selectedFolder.length > 0) {
      url += "&folder=" + encodeURIComponent($scope.selectedFolder);
    }
    url += "&order=" + encodeURIComponent($scope.sortOrder);
    $http.get(url).success(function(data) {
      $scope.messages = data.items || [];
      $scope.totalMessages = data.total;
      $scope.countMessages = data.count;
      $scope.startMessages = data.start;

      if($scope.autoSelectFirstOnNextRefresh) {
        var messageToSelect = null;
        if($scope.restoreMessageIDOnNextRefresh) {
          for(var rememberIdx = 0; rememberIdx < $scope.messages.length; rememberIdx++) {
            if($scope.messages[rememberIdx].ID === $scope.restoreMessageIDOnNextRefresh) {
              messageToSelect = $scope.messages[rememberIdx];
              break;
            }
          }
        }

        if(!messageToSelect && $scope.messages.length > 0) {
          messageToSelect = $scope.messages[0];
        }

        if(messageToSelect) {
          $scope.selectMessage(messageToSelect);
        } else {
          $scope.preview = null;
          $scope.selectedMessageID = null;
          $scope.previewAllHeaders = false;
        }
        $scope.restoreMessageIDOnNextRefresh = null;
        $scope.autoSelectFirstOnNextRefresh = false;
      } else if($scope.selectedMessageID) {
        var foundSelected = false;
        for(var i = 0; i < $scope.messages.length; i++) {
          if($scope.messages[i].ID === $scope.selectedMessageID) {
            foundSelected = true;
            break;
          }
        }
        if(!foundSelected) {
          $scope.preview = null;
          $scope.selectedMessageID = null;
          $scope.previewAllHeaders = false;
        }
      }

      $scope.syncSelectionWithVisibleMessages();
      $scope.refreshFolders();
      e.done();
    });
  }
  $scope.refresh();
  $scope.fetchSettings();

  $scope.showNewer = function() {
    if(!$scope.canShowNewer()) {
      return;
    }
    if($scope.sortOrder === "asc") {
      $scope.startIndex += $scope.itemsPerPage;
    } else {
      $scope.startIndex -= $scope.itemsPerPage;
      if($scope.startIndex < 0) {
        $scope.startIndex = 0
      }
    }
    $scope.refresh();
  }

  $scope.showUpdated = function(i) {
    $scope.itemsPerPage = parseInt(i, 10);
    if(typeof(Storage) !== "undefined") {
        localStorage.setItem("itemsPerPage", $scope.itemsPerPage)
    }
    $scope.refresh();
  }

  $scope.showOlder = function() {
    if(!$scope.canShowOlder()) {
      return;
    }
    if($scope.sortOrder === "asc") {
      $scope.startIndex -= $scope.itemsPerPage;
      if($scope.startIndex < 0) {
        $scope.startIndex = 0;
      }
    } else {
      $scope.startIndex += $scope.itemsPerPage;
    }
    $scope.refresh();
  }

  $scope.search = function(kind, text) {
    $scope.showSettings = false;
    $scope.startIndex = 0;
    $scope.searching = true;
    $scope.searchKind = kind;
    $scope.searchedText = text;
    $scope.searchText = "";
    $scope.startSearchMessages = 0
    $scope.countSearchMessages = 0
    $scope.totalSearchMessages = 0
    $scope.refreshSearch()
  }

  $scope.refreshSearch = function() {
    var url = $scope.host + 'api/v2/search?kind=' + $scope.searchKind + '&query=' + $scope.searchedText;
    if($scope.startIndex > 0) {
      url += "&start=" + $scope.startIndex;
    }
    url += "&limit=" + $scope.itemsPerPage;
    url += "&order=" + encodeURIComponent($scope.sortOrder);
    if($scope.selectedFolder && $scope.selectedFolder.length > 0) {
      url += "&folder=" + encodeURIComponent($scope.selectedFolder);
    }
    $http.get(url).success(function(data) {
      $scope.searchMessages = data.items;
      $scope.totalSearchMessages = data.total;
      $scope.countSearchMessages = data.count;
      $scope.startSearchMessages = data.start;
      $scope.syncSelectionWithVisibleMessages();
    });
  }

  $scope.hasSelection = function() {
    return $(".messages :checked").length > 0 ? true : false;
  }

  $scope.selectMessage = function(message) {
    if(!message || !message.ID) {
      return;
    }
    $scope.showSettings = false;
    $scope.selectedMessageID = message.ID;
    $scope.setMessageReadStateByID(message.ID, true);
    $scope.rememberSelectedMessageForCurrentFolder(message.ID);
    $timeout(function(){
      $scope.resizePreview();
    }, 0);
  	if($scope.cache[message.ID]) {
  		$scope.preview = $scope.cache[message.ID];
      $scope.loadEmailQuality($scope.preview);
      //reflow();
  	} else {
  		$scope.preview = message;
      var e = $scope.startEvent("Loading message", message.ID, "glyphicon-download-alt");
	  	$http.get($scope.host + 'api/v1/messages/' + message.ID).success(function(data) {
	  	  $scope.cache[message.ID] = data;

        // FIXME
        // - nested mime parts can't be downloaded

        data.$cidMap = {};
        if(data.MIME && data.MIME.Parts.length) {
          for(p in data.MIME.Parts) {
            for(h in data.MIME.Parts[p].Headers) {
              if(h.toLowerCase() == "content-id") {
                cid = data.MIME.Parts[p].Headers[h][0]
                cid = cid.substr(1,cid.length-2)
                data.$cidMap[cid] = "api/v1/messages/" + message.ID + "/mime/part/" + p + "/download"
              }
            }
          }
        }
        console.log(data.$cidMap)
        // TODO
        // - scan HTML parts for elements containing CID URI and replace

        h = $scope.getMessageHTML(data)
        for(c in data.$cidMap) {
	  str = "cid:" + c;
	  pat = str.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, "\\$1");
          h = h.replace(new RegExp(pat, 'g'), data.$cidMap[c])
        }
	      data.previewHTML = $sce.trustAsHtml(h);
  		  $scope.preview = data;
        $scope.loadEmailQuality(data);
  		  preview = $scope.cache[message.ID];
        //reflow();
        e.done();
	    });
	   }
  }

  $scope.toggleHeaders = function(val) {
    $scope.previewAllHeaders = val;
    $timeout(function(){
      $scope.resizePreview();
    }, 0);
    var t = window.setInterval(function() {
      if(val) {
        if($('#hide-headers').length) {
          window.clearInterval(t);
          //reflow();
        }
      } else {
        if($('#show-headers').length) {
          window.clearInterval(t);
          //reflow();
        }
      }
    }, 10);
  }

  $scope.fileSize = function(bytes) {
    return filesize(bytes)
  }

  $scope.tryDecodeContent = function(message) {
    var charset = "UTF-8"
    if(message.Content.Headers["Content-Type"][0]) {
      // TODO
    }

    var content = message.Content.Body;
    var contentTransferEncoding = message.Content.Headers["Content-Transfer-Encoding"][0];

    if(contentTransferEncoding) {
      switch (contentTransferEncoding.toLowerCase()) {
        case 'quoted-printable':
          content = content.replace(/=[\r\n]+/gm,"");
          content = unescapeFromQuotedPrintableWithoutRFC2047(content, charset);
          break;
        case 'base64':
          // remove line endings to give original base64-encoded string
          content = content.replace(/\r?\n|\r/gm,"");
          content = unescapeFromBase64(content, charset);
          break;
      }
    }

    return content;
  }

  $scope.formatMessagePlain = function(message) {
    var body = $scope.getMessagePlain(message);
    var escaped = $scope.escapeHtml(body);
    var formatted = escaped.replace(/(https?:\/\/)([-[\]A-Za-z0-9._~:/?#@!$()*+,;=%]|&amp;|&#39;)+/g, '<a href="$&" target="_blank">$&</a>');
    return $sce.trustAsHtml(formatted);
  }

  $scope.escapeHtml = function(html) {
    var entityMap = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    return html.replace(/[&<>"']/g, function (s) {
      return entityMap[s];
    });
  }

  $scope.getMessagePlain = function(message) {
    if (message.Content.Headers && message.Content.Headers["Content-Type"] && message.Content.Headers["Content-Type"][0].match("text/plain")) {
      return $scope.tryDecode(message.Content);
    }
    var l = $scope.findMatchingMIME(message, "text/plain");
    if(l != null && l !== "undefined") {
      return $scope.tryDecode(l);
    }
    return message.Content.Body;
  }

  $scope.findMatchingMIME = function(part, mime) {
    // TODO cache results
    if(part.MIME) {
      for(var p in part.MIME.Parts) {
        if("Content-Type" in part.MIME.Parts[p].Headers) {
          if(part.MIME.Parts[p].Headers["Content-Type"].length > 0) {
            if(part.MIME.Parts[p].Headers["Content-Type"][0].match(mime + ";?.*")) {
              return part.MIME.Parts[p];
            } else if (part.MIME.Parts[p].Headers["Content-Type"][0].match(/multipart\/.*/)) {
              var f = $scope.findMatchingMIME(part.MIME.Parts[p], mime);
              if(f != null) {
                return f;
              }
            }
          }
        }
      }
    }
    return null;
  }
  $scope.hasHTML = function(message) {
    // TODO cache this
    for(var header in message.Content.Headers) {
      if(header.toLowerCase() == 'content-type') {
        if(message.Content.Headers[header][0].match("text/html")) {
          return true
        }
      }
    }

    var l = $scope.findMatchingMIME(message, "text/html");
    if(l != null && l !== "undefined") {
      return true
    }
    return false;
  }
  $scope.getMessageHTML = function(message) {
    console.log(message);
    for(var header in message.Content.Headers) {
      if(header.toLowerCase() == 'content-type') {
        if(message.Content.Headers[header][0].match("text/html")) {
          return $scope.tryDecode(message.Content);
        }
      }
    }

    var l = $scope.findMatchingMIME(message, "text/html");
    if(l != null && l !== "undefined") {
      return $scope.tryDecode(l);
    }
  	return "<HTML not found>";
	}

  $scope.tryDecode = function(l){
    if(l.Headers && l.Headers["Content-Type"] && l.Headers["Content-Transfer-Encoding"]){
      return $scope.tryDecodeContent({Content:l});
    }else{
      return l.Body;
    }
  };
  $scope.date = function(timestamp) {
  	return (new Date(timestamp)).toString();
  };

  $scope.deleteAll = function() {
  	$('#confirm-delete-all').modal('show');
  }

  $scope.clearPendingFolderDelete = function() {
    $scope.folderPendingDelete = "";
    $scope.folderPendingDeleteIsInbox = false;
  }

  $scope.performFolderDelete = function(folderName, allowInbox) {
    var targetFolder = (folderName || "").trim();
    var isInboxTarget = !!allowInbox || $scope.normalizeFolderName(targetFolder).length === 0;
    if(!isInboxTarget && targetFolder.length === 0) {
      return;
    }

    var eventLabel = isInboxTarget ? "Inbox" : targetFolder;
    var eventName = isInboxTarget ? "Deleting inbox messages" : "Deleting folder messages";
    var e = $scope.startEvent(eventName, eventLabel, "glyphicon-trash");
    var url = $scope.host + 'api/v2/messages?folder=' + encodeURIComponent(targetFolder);
    $http.delete(url).success(function() {
      delete $scope.lastSelectedMessageByFolder[$scope.getFolderSelectionKey(targetFolder)];
      if($scope.normalizeFolderName($scope.selectedFolder) === $scope.normalizeFolderName(targetFolder)) {
        $scope.selectedFolder = "";
        $scope.setSavedFolderPreference("");
      }
      $scope.preview = null;
      $scope.selectedMessageID = null;
      $scope.startIndex = 0;
      $scope.startMessages = 0;
      $scope.searching = false;
      $scope.refresh();
      e.done();
    }).error(function(err) {
      e.fail();
      e.error = err;
    });
  }

  $scope.deleteFolder = function(folderName, $event) {
    if($event) {
      $event.preventDefault();
      $event.stopPropagation();
    }
    if(!folderName || folderName.length === 0) {
      return;
    }
    $scope.folderPendingDelete = folderName;
    $scope.folderPendingDeleteIsInbox = false;
    $('#confirm-delete-folder').modal('show');
  }

  $scope.deleteInboxMessages = function($event) {
    if($event) {
      $event.preventDefault();
      $event.stopPropagation();
    }
    $scope.folderPendingDelete = "";
    $scope.folderPendingDeleteIsInbox = true;
    $('#confirm-delete-folder').modal('show');
  }

  $scope.deleteFolderConfirm = function() {
    $('#confirm-delete-folder').modal('hide');
    var folderName = $scope.folderPendingDelete;
    var deleteInboxMessages = $scope.folderPendingDeleteIsInbox;
    $scope.clearPendingFolderDelete();
    $scope.performFolderDelete(folderName, deleteInboxMessages);
  }

  $scope.releaseOne = function(message) {
    $scope.releasing = message;

    $http.get($scope.host + 'api/v2/outgoing-smtp').success(function(data) {
      $scope.outgoingSMTP = data;
      $('#release-one').modal('show');
    })
  }
  $scope.confirmReleaseMessage = function() {
    $('#release-one').modal('hide');
    var message = $scope.releasing;
    $scope.releasing = null;

    var e = $scope.startEvent("Releasing message", message.ID, "glyphicon-share");

    if($('#release-message-outgoing').val().length > 0) {
      authcfg = {
        name: $('#release-message-outgoing').val(),
        email: $('#release-message-email').val(),
      }
    } else {
      authcfg = {
        email: $('#release-message-email').val(),
        host: $('#release-message-smtp-host').val(),
        port: $('#release-message-smtp-port').val(),
        mechanism: $('#release-message-smtp-mechanism').val(),
        username: $('#release-message-smtp-username').val(),
        password: $('#release-message-smtp-password').val(),
        save: $('#release-message-save').is(":checked") ? true : false,
        name: $('#release-message-server-name').val(),
      }
    }

    $http.post($scope.host + 'api/v1/messages/' + message.ID + '/release', authcfg).success(function() {
      e.done();
    }).error(function(err) {
      e.fail();
      e.error = err;
    });
  }

  $scope.getSource = function(message) {
  	var source = "";
  	$.each(message.Content.Headers, function(k, v) {
  		source += k + ": " + v + "\n";
  	});
	source += "\n";
	source += message.Content.Body;
	return source;
  }

  $scope.deleteAllConfirm = function() {
  	$('#confirm-delete-all').modal('hide');
    var e = $scope.startEvent("Deleting all messages", null, "glyphicon-remove-circle");
  	$http.delete($scope.host + 'api/v2/messages').success(function() {
      $scope.lastSelectedMessageByFolder = {};
      $scope.restoreMessageIDOnNextRefresh = null;
      $scope.favoriteStateByMessageID = {};
      $scope.readStateByMessageID = {};
      $scope.attachmentCacheByMessageID = {};
      $scope.qualityCacheByMessageID = {};
      $scope.persistFavoriteState();
      $scope.persistReadState();
  		$scope.refresh();
  		$scope.preview = null;
      $scope.selectedMessageID = null;
      e.done()
  	});
  }

  $scope.deleteOne = function(message) {
    var e = $scope.startEvent("Deleting message", message.ID, "glyphicon-remove");
  	$http.delete($scope.host + 'api/v1/messages/' + message.ID).success(function() {
      $scope.forgetRememberedMessageID(message.ID);
      delete $scope.favoriteStateByMessageID[message.ID];
      delete $scope.readStateByMessageID[message.ID];
      delete $scope.attachmentCacheByMessageID[message.ID];
      delete $scope.qualityCacheByMessageID[message.ID];
      $scope.persistFavoriteState();
      $scope.persistReadState();
      if($scope.selectedMessageID === message.ID) {
        $scope.selectedMessageID = null;
      }
  		if($scope.preview && ($scope.preview._id == message._id || $scope.preview.ID === message.ID)) $scope.preview = null;
  		$scope.refresh();
      e.done();
  	});
  }
});
