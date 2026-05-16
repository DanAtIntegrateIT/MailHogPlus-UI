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

mailhogApp.controller('MailCtrl', function ($scope, $http, $sce, $timeout, $document, $interval) {
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
  $scope.pendingSavedTagSelection = null;
  $scope.showFavoritesOnly = false;
  $scope.favoriteStateByMessageID = {};
  $scope.readStateByMessageID = {};
  $scope.attachmentCacheByMessageID = {};
  $scope.qualityCacheByMessageID = {};
  $scope.qualityRequestInFlightByMessageID = {};
  $scope.previewRequestSequence = 0;
  $scope.previewLoadingTimerPromise = null;

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
      var savedTag = localStorage.getItem("mailhogSelectedTag");
      if(savedTag !== null) {
        $scope.pendingSavedTagSelection = savedTag;
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
      $scope.savedReleaseEmailAddress = (localStorage.getItem("mailhogReleaseEmailAddress") || "").trim();
      try {
        var savedReleaseEmailMap = localStorage.getItem("mailhogReleaseEmailByServer");
        if(savedReleaseEmailMap) {
          $scope.savedReleaseEmailAddressByServer = JSON.parse(savedReleaseEmailMap) || {};
        }
      } catch(e) {
        $scope.savedReleaseEmailAddressByServer = {};
      }
  }

  $scope.startMessages = 0
  $scope.countMessages = 0
  $scope.totalMessages = 0

  $scope.startSearchMessages = 0
  $scope.countSearchMessages = 0
  $scope.totalSearchMessages = 0

  $scope.jim = null

  $scope.selectedOutgoingSMTP = ""
  $scope.releaseEmailAddress = "";
  $scope.savedReleaseEmailAddress = $scope.savedReleaseEmailAddress || "";
  $scope.savedReleaseEmailAddressByServer = $scope.savedReleaseEmailAddressByServer || {};
  $scope.configuredOutgoingSMTP = {};
  $scope.configuredOutgoingSMTPNames = [];
  $scope.selectedFolder = "";
  $scope.selectedTag = "";
  $scope.tagFilterInput = "";
  $scope.folderPendingDelete = "";
  $scope.folderPendingDeleteIsInbox = false;
  $scope.folderPendingDeleteIncludeFavorites = false;
  $scope.lastArrivalFolderKey = null;
  $scope.folders = [];
  $scope.folderUnreadCounts = {};
  $scope.messageFolderByID = {};
  $scope.folderUnreadCountsRequestToken = 0;
  $scope.showSettings = false;
  $scope.showLogs = false;
  $scope.mailboxLoading = false;
  $scope.listPaneLoading = false;
  $scope.previewLoading = false;
  $scope.logsLoading = false;
  $scope.logsClearing = false;
  $scope.logsAutoRefreshEnabled = true;
  $scope.logsError = "";
  $scope.logs = [];
  $scope.logFilePath = "";
  $scope.logQuery = "";
  $scope.logLinesLimit = 250;
  var logsAutoRefreshTimer = null;
  $scope.settingsLoading = false;
  $scope.settingsSaving = false;
  $scope.settingsStatus = "";
  $scope.settingsError = "";
  $scope.settingsForm = {
    retentionDays: 10,
    storageType: "maildir",
    maildirPath: "",
    defaultFolders: [],
    forceDefaultInboxOnly: false,
    outgoingSMTP: []
  };
  $scope.settingsDefaultFolderInput = "";
  $scope.settingsRequiresRestart = false;
  $scope.settingsLoadedSnapshot = null;
  $scope.settingsDirty = false;
  $scope.messages = [];
  $scope.searchMessages = [];
  if($scope.pendingSavedTagSelection !== null) {
    $scope.selectedTag = ($scope.pendingSavedTagSelection || "").trim();
    $scope.tagFilterInput = $scope.selectedTag;
    $scope.pendingSavedTagSelection = null;
  }

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

  $scope.getTagFromMessage = function(message) {
    var tags = $scope.getTagsFromMessage(message);
    if(!tags || tags.length === 0) {
      return "";
    }
    return tags.join(":");
  }

  $scope.getTagsFromMessage = function(message) {
    if(!message || !message.Content || !message.Content.Headers) {
      return [];
    }

    var tags = [];
    var seen = {};
    var addTagCandidate = function(rawValue) {
      if(!rawValue) {
        return;
      }
      var parts = rawValue.split(":");
      for(var p = 0; p < parts.length; p++) {
        var candidate = (parts[p] || "").trim();
        if(candidate.length === 0) {
          continue;
        }
        var normalized = candidate.toLowerCase();
        if(seen[normalized]) {
          continue;
        }
        seen[normalized] = true;
        tags.push(candidate);
      }
    };

    for(var key in message.Content.Headers) {
      if(!key) {
        continue;
      }
      var normalizedKey = key.toLowerCase();
      if(normalizedKey === "x-mailhogplus-tags" || normalizedKey === "x-mailhogplus-tag") {
        var values = message.Content.Headers[key];
        if(values && values.length > 0) {
          for(var i = 0; i < values.length; i++) {
            addTagCandidate(values[i]);
          }
        }
      }
    }

    // Compatibility fallback: older messages can store username as folder
    // (e.g. "amazon:finance") without an explicit X-MailHogPlus-Tag header.
    if(tags.length === 0) {
      var folderValue = $scope.getFolderFromMessage(message);
      if(folderValue && folderValue.indexOf(":") >= 0) {
        var folderParts = folderValue.split(":");
        for(var j = 1; j < folderParts.length; j++) {
          addTagCandidate(folderParts[j]);
        }
      }
    }

    // Last fallback: for generated test emails where auth headers are absent,
    // derive tags from body text line SMTP Username: folder:tag1:tag2.
    if(tags.length === 0) {
      var bodyCandidates = [];
      if(message.Content && message.Content.Body) {
        bodyCandidates.push(message.Content.Body);
      }
      try {
        var plainBody = $scope.getMessagePlain(message);
        if(plainBody && bodyCandidates.indexOf(plainBody) < 0) {
          bodyCandidates.push(plainBody);
        }
      } catch(e) {
        // Ignore decoding/parsing failures and keep existing fallbacks.
      }

      for(var b = 0; b < bodyCandidates.length && tags.length === 0; b++) {
        var bodyText = bodyCandidates[b] || "";
        if(bodyText.length === 0) {
          continue;
        }
        var normalizedBody = bodyText.replace(/<[^>]*>/g, " ");
        var usernameMatch = /smtp\s+username:\s*([^\s<\r\n]+)/i.exec(normalizedBody);
        if(!usernameMatch || !usernameMatch[1]) {
          continue;
        }
        var username = usernameMatch[1].trim();
        if(username.indexOf(":") < 0) {
          continue;
        }
        var usernameParts = username.split(":");
        for(var u = 1; u < usernameParts.length; u++) {
          addTagCandidate(usernameParts[u]);
        }
      }
    }
    return tags;
  }

  $scope.getPreviewTags = function(message) {
    var tags = $scope.getTagsFromMessage(message) || [];
    if(tags.length <= 1) {
      return tags;
    }

    var nonRagTags = [];
    var ragTags = [];
    for(var i = 0; i < tags.length; i++) {
      var tag = tags[i];
      if($scope.normalizeTagName(tag) === "rag") {
        ragTags.push(tag);
      } else {
        nonRagTags.push(tag);
      }
    }
    return nonRagTags.concat(ragTags);
  }

  $scope.normalizeFolderName = function(folderName) {
    if(!folderName) {
      return "";
    }
    return folderName.trim().toLowerCase();
  }

  $scope.normalizeTagName = function(tagName) {
    if(!tagName) {
      return "";
    }
    return tagName.trim().toLowerCase();
  }

  $scope.getFolderSelectionKey = function(folderName) {
    var normalizedFolder = $scope.normalizeFolderName(folderName);
    var normalizedTag = $scope.normalizeTagName($scope.selectedTag);
    var tagKey = normalizedTag.length > 0 ? ("|tag:" + normalizedTag) : "";
    if(normalizedFolder.length === 0) {
      return "inbox" + tagKey;
    }
    return "folder:" + normalizedFolder + tagKey;
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
    var tags = $scope.getTagsFromMessage(message);
    var selectedFolder = $scope.normalizeFolderName($scope.selectedFolder);
    var selectedTag = $scope.normalizeTagName($scope.selectedTag);
    if(selectedFolder.length > 0) {
      if(folder !== selectedFolder) {
        return false;
      }
    } else if(folder.length !== 0) {
      return false;
    }
    if(selectedTag.length > 0) {
      for(var i = 0; i < tags.length; i++) {
        if($scope.normalizeTagName(tags[i]) === selectedTag) {
          return true;
        }
      }
      return false;
    }
    return true;
  }

  $scope.messageMatchesSelectedTag = function(message) {
    var selectedTag = $scope.normalizeTagName($scope.selectedTag);
    if(selectedTag.length === 0) {
      return true;
    }
    var tags = $scope.getTagsFromMessage(message) || [];
    for(var i = 0; i < tags.length; i++) {
      if($scope.normalizeTagName(tags[i]) === selectedTag) {
        return true;
      }
    }
    return false;
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

  $scope.getFolderUnreadCount = function(folderName) {
    var normalizedFolderName = $scope.normalizeFolderName(folderName);
    if(normalizedFolderName.length === 0) {
      return 0;
    }
    return $scope.folderUnreadCounts[normalizedFolderName] || 0;
  }

  $scope.folderHasAnyMessages = function(folder) {
    if(!folder) {
      return false;
    }
    return (parseInt(folder.count, 10) || 0) > 0;
  }

  $scope.addToFolderUnreadCount = function(folderName, delta) {
    var normalizedFolderName = $scope.normalizeFolderName(folderName);
    if(normalizedFolderName.length === 0 || !delta) {
      return;
    }
    var current = $scope.folderUnreadCounts[normalizedFolderName] || 0;
    var next = current + delta;
    if(next <= 0) {
      delete $scope.folderUnreadCounts[normalizedFolderName];
      return;
    }
    $scope.folderUnreadCounts[normalizedFolderName] = next;
  }

  $scope.trackMessageFolder = function(message) {
    if(!message || !message.ID) {
      return;
    }
    var normalizedFolderName = $scope.normalizeFolderName($scope.getFolderFromMessage(message));
    if(normalizedFolderName.length === 0) {
      delete $scope.messageFolderByID[message.ID];
      return;
    }
    $scope.messageFolderByID[message.ID] = normalizedFolderName;
  }

  $scope.refreshFolderUnreadCounts = function() {
    var requestToken = ++$scope.folderUnreadCountsRequestToken;
    var limit = 250;
    var unreadCounts = {};
    var trackedFolders = {};
    var folderNames = [];
    var seenFolders = {};

    for(var folderIndex = 0; folderIndex < $scope.folders.length; folderIndex++) {
      var folderName = ($scope.folders[folderIndex].name || "").trim();
      var normalizedFolderName = $scope.normalizeFolderName(folderName);
      if(normalizedFolderName.length === 0 || seenFolders[normalizedFolderName]) {
        continue;
      }
      seenFolders[normalizedFolderName] = true;
      folderNames.push(folderName);
    }

    if(folderNames.length === 0) {
      $scope.folderUnreadCounts = {};
      $scope.messageFolderByID = {};
      return;
    }

    var applyMessage = function(message) {
      if(!message || !message.ID) {
        return;
      }
      var normalizedFolderName = $scope.normalizeFolderName($scope.getFolderFromMessage(message));
      if(normalizedFolderName.length > 0) {
        trackedFolders[message.ID] = normalizedFolderName;
      }
      if(normalizedFolderName.length === 0 || $scope.isMessageRead(message)) {
        return;
      }
      unreadCounts[normalizedFolderName] = (unreadCounts[normalizedFolderName] || 0) + 1;
    };

    var loadFolder = function(folderPosition) {
      if(folderPosition >= folderNames.length) {
        return;
      }

      var folderName = folderNames[folderPosition];
      var start = 0;

      var loadPage = function() {
        var url = $scope.host + 'api/v2/messages?folder=' + encodeURIComponent(folderName) + '&start=' + start + '&limit=' + limit + '&order=desc';
        if($scope.selectedTag && $scope.selectedTag.length > 0) {
          url += '&tag=' + encodeURIComponent($scope.selectedTag);
        }
        $http.get(url).success(function(data) {
          if(requestToken !== $scope.folderUnreadCountsRequestToken) {
            return;
          }
          var items = (data && data.items) ? data.items : [];
          for(var i = 0; i < items.length; i++) {
            applyMessage(items[i]);
          }

          // Apply partial results page-by-page so first load shows unread badges
          // immediately instead of waiting for the full mailbox scan to finish.
          $scope.folderUnreadCounts = unreadCounts;
          $scope.messageFolderByID = trackedFolders;

          start += items.length;
          var total = parseInt(data && data.total, 10);
          if(isNaN(total) || total < start) {
            total = start;
          }
          if(items.length === 0 || start >= total) {
            loadFolder(folderPosition + 1);
            return;
          }
          loadPage();
        }).error(function() {
          // Keep current unread counters on failure and continue scanning.
          loadFolder(folderPosition + 1);
        });
      };

      loadPage();
    };

    loadFolder(0);
  }

  $scope.markLastArrivalFolder = function(folderName) {
    $scope.lastArrivalFolderKey = $scope.normalizeFolderName(folderName);
  }

  $scope.isLastArrivalInbox = function() {
    return $scope.lastArrivalFolderKey !== null && $scope.lastArrivalFolderKey.length === 0;
  }

  $scope.isLastArrivalFolder = function(folderName) {
    var normalizedFolderName = $scope.normalizeFolderName(folderName);
    if(normalizedFolderName.length === 0) {
      return false;
    }
    return $scope.lastArrivalFolderKey !== null && normalizedFolderName === $scope.lastArrivalFolderKey;
  }

  $scope.clearLastArrivalIndicatorForFolder = function(folderName) {
    var normalizedFolderName = $scope.normalizeFolderName(folderName);
    if($scope.lastArrivalFolderKey === null) {
      return;
    }
    if($scope.lastArrivalFolderKey === normalizedFolderName) {
      $scope.lastArrivalFolderKey = null;
    }
  }

  $scope.clearLastArrivalIndicatorForMessage = function(message) {
    if(!message) {
      return;
    }
    $scope.clearLastArrivalIndicatorForFolder($scope.getFolderFromMessage(message));
  }

  $scope.refreshFolders = function() {
    $http.get($scope.host + 'api/v2/folders').success(function(data) {
      $scope.folders = data.items || [];
      $scope.sortFolders();
      $scope.refreshFolderUnreadCounts();
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

  $scope.setSavedTagPreference = function(tagName) {
    if(typeof(Storage) === "undefined") {
      return;
    }
    localStorage.setItem("mailhogSelectedTag", (tagName || "").trim());
  }

  $scope.applyTagFilter = function(tagName) {
    var newTag = (tagName || "").trim();
    if($scope.selectedTag === newTag) {
      return;
    }
    $scope.queueFolderSelectionRestore($scope.selectedFolder || "");
    $scope.selectedTag = newTag;
    $scope.tagFilterInput = newTag;
    $scope.startIndex = 0;
    $scope.startMessages = 0;
    $scope.startSearchMessages = 0;
    $scope.setSavedTagPreference(newTag);
    $scope.refreshFolderUnreadCounts();
    $scope.refresh();
  }

  $scope.clearTagFilter = function() {
    $scope.applyTagFilter("");
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

  $scope.persistReleaseEmailState = function() {
    if(typeof(Storage) === "undefined") {
      return;
    }
    localStorage.setItem("mailhogReleaseEmailAddress", ($scope.savedReleaseEmailAddress || "").trim());
    localStorage.setItem("mailhogReleaseEmailByServer", JSON.stringify($scope.savedReleaseEmailAddressByServer || {}));
  }

  $scope.getSavedReleaseEmailForServer = function(serverName) {
    var selectedServer = (serverName || "").trim();
    if(selectedServer.length > 0) {
      var savedServerEmail = ($scope.savedReleaseEmailAddressByServer[selectedServer] || "").trim();
      if(savedServerEmail.length > 0) {
        return savedServerEmail;
      }
    }
    return ($scope.savedReleaseEmailAddress || "").trim();
  }

  $scope.rememberReleaseEmail = function(serverName, emailAddress) {
    var selectedServer = (serverName || "").trim();
    var targetEmail = (emailAddress || "").trim();
    if(targetEmail.length === 0) {
      return;
    }
    $scope.savedReleaseEmailAddress = targetEmail;
    if(selectedServer.length > 0) {
      $scope.savedReleaseEmailAddressByServer[selectedServer] = targetEmail;
    }
    $scope.persistReleaseEmailState();
  }

  $scope.pruneFavoriteStateForDeletedMessages = function() {
    var trackedIDs = [];
    for(var messageID in ($scope.favoriteStateByMessageID || {})) {
      if($scope.favoriteStateByMessageID[messageID]) {
        trackedIDs.push(messageID);
      }
    }
    if(trackedIDs.length === 0) {
      return;
    }

    $http.post($scope.host + 'api/v2/messages/existing-ids', { ids: trackedIDs }).success(function(data) {
      var existing = {};
      var existingIDs = (data && data.existingIds) ? data.existingIds : [];
      for(var i = 0; i < existingIDs.length; i++) {
        existing[existingIDs[i]] = true;
      }

      var changed = false;
      for(var j = 0; j < trackedIDs.length; j++) {
        var id = trackedIDs[j];
        if(!existing[id] && $scope.favoriteStateByMessageID[id]) {
          delete $scope.favoriteStateByMessageID[id];
          changed = true;
        }
      }

      if(changed) {
        $scope.persistFavoriteState();
        $scope.syncSelectionWithVisibleMessages();
      }
    });
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
      return;
    }

    message.qualityLoading = true;
    message.qualityError = "";

    if($scope.qualityRequestInFlightByMessageID[messageID]) {
      return;
    }

    $scope.qualityRequestInFlightByMessageID[messageID] = true;
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
    }).finally(function() {
      delete $scope.qualityRequestInFlightByMessageID[messageID];
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

  $scope.setMessageReadStateByID = function(messageID, isRead, message) {
    if(!messageID) {
      return;
    }
    var wasRead = !!$scope.readStateByMessageID[messageID];
    var willBeRead = !!isRead;
    if(isRead) {
      $scope.readStateByMessageID[messageID] = true;
    } else {
      delete $scope.readStateByMessageID[messageID];
    }
    var normalizedFolderName = "";
    if(message) {
      normalizedFolderName = $scope.normalizeFolderName($scope.getFolderFromMessage(message));
      $scope.trackMessageFolder(message);
    }
    if(normalizedFolderName.length === 0 && $scope.messageFolderByID[messageID]) {
      normalizedFolderName = $scope.messageFolderByID[messageID];
    }
    if(normalizedFolderName.length > 0 && wasRead !== willBeRead && $scope.messageMatchesSelectedTag(message)) {
      $scope.addToFolderUnreadCount(normalizedFolderName, willBeRead ? -1 : 1);
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
    var willBeRead = !$scope.isMessageRead(message);
    $scope.setMessageReadStateByID(message.ID, willBeRead, message);
    if(willBeRead) {
      $scope.clearLastArrivalIndicatorForMessage(message);
    }
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
    if($scope.showSettings || $scope.showLogs) {
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
    if(logsAutoRefreshTimer) {
      $interval.cancel(logsAutoRefreshTimer);
      logsAutoRefreshTimer = null;
    }
    if($scope.previewLoadingTimerPromise) {
      $timeout.cancel($scope.previewLoadingTimerPromise);
      $scope.previewLoadingTimerPromise = null;
    }
  });

  $scope.selectInbox = function() {
    $scope.showSettings = false;
    $scope.showLogs = false;
    $scope.mailboxLoading = true;
    $scope.listPaneLoading = true;
    $scope.previewLoading = false;
    $scope.countMessages = 0;
    $scope.totalMessages = 0;
    $scope.countSearchMessages = 0;
    $scope.totalSearchMessages = 0;
    $scope.selectedMessageID = null;
    $scope.queueFolderSelectionRestore("");
    $scope.selectedFolder = "";
    $scope.clearLastArrivalIndicatorForFolder("");
    $scope.startIndex = 0;
    $scope.startMessages = 0;
    $scope.searching = false;
    $scope.setSavedFolderPreference("");
    $scope.refresh();
  }

  $scope.selectFolder = function(folderName) {
    $scope.showSettings = false;
    $scope.showLogs = false;
    $scope.mailboxLoading = true;
    $scope.listPaneLoading = true;
    $scope.previewLoading = false;
    $scope.countMessages = 0;
    $scope.totalMessages = 0;
    $scope.countSearchMessages = 0;
    $scope.totalSearchMessages = 0;
    $scope.selectedMessageID = null;
    $scope.queueFolderSelectionRestore(folderName || "");
    $scope.selectedFolder = folderName || "";
    $scope.clearLastArrivalIndicatorForFolder($scope.selectedFolder);
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

  $scope.openRagExplainedModal = function() {
    $('#rag-explained-modal').modal('show');
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

  $scope.newOutgoingSMTPServer = function() {
    return {
      name: "",
      host: "",
      port: "25",
      mechanism: "NONE",
      username: "",
      password: "",
      email: "",
      testing: false,
      testStatus: "",
      testMessage: "",
      testError: ""
    };
  }

  $scope.normalizeOutgoingSMTPServer = function(rawServer, fallbackName) {
    var source = rawServer || {};
    var readField = function(lowerKey, upperKey, defaultValue) {
      if(source[lowerKey] !== undefined && source[lowerKey] !== null) {
        return source[lowerKey];
      }
      if(source[upperKey] !== undefined && source[upperKey] !== null) {
        return source[upperKey];
      }
      return defaultValue;
    };

    var mechanismValue = ("" + readField("mechanism", "Mechanism", "NONE")).trim().toUpperCase();
    if(mechanismValue !== "PLAIN" && mechanismValue !== "CRAMMD5") {
      mechanismValue = "NONE";
    }

    var nameValue = ("" + readField("name", "Name", "")).trim();
    if(nameValue.length === 0 && fallbackName) {
      nameValue = ("" + fallbackName).trim();
    }

    var normalized = {
      name: nameValue,
      host: ("" + readField("host", "Host", "")).trim(),
      port: ("" + readField("port", "Port", "")).trim(),
      mechanism: mechanismValue,
      username: ("" + readField("username", "Username", "")).trim(),
      password: "" + readField("password", "Password", ""),
      email: ("" + readField("email", "Email", "")).trim()
    };
    if(normalized.mechanism === "NONE") {
      normalized.username = "";
      normalized.password = "";
    }
    return normalized;
  }

  $scope.extractOutgoingSMTPServers = function(rawServers) {
    if(!rawServers) {
      return [];
    }
    if(Array.isArray(rawServers)) {
      return rawServers;
    }
    var extracted = [];
    angular.forEach(rawServers, function(server, key) {
      extracted.push($scope.normalizeOutgoingSMTPServer(server, key));
    });
    return extracted;
  }

  $scope.sanitizeOutgoingSMTPServers = function(rawServers) {
    var sourceServers = $scope.extractOutgoingSMTPServers(rawServers);
    var cleaned = [];
    var seen = {};
    for(var i = 0; i < sourceServers.length; i++) {
      var server = $scope.normalizeOutgoingSMTPServer(sourceServers[i]);
      var hasAnyValue = server.name.length > 0 ||
        server.host.length > 0 ||
        server.port.length > 0 ||
        server.email.length > 0 ||
        server.username.length > 0 ||
        server.password.length > 0 ||
        server.mechanism !== "NONE";
      if(!hasAnyValue) {
        continue;
      }
      if(server.name.length === 0 || server.host.length === 0 || server.port.length === 0) {
        continue;
      }
      var normalizedName = server.name.toLowerCase();
      if(seen[normalizedName]) {
        continue;
      }
      seen[normalizedName] = true;
      cleaned.push(server);
    }
    cleaned.sort(function(a, b) {
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    return cleaned;
  }

  $scope.outgoingSMTPSnapshot = function(rawServers) {
    var sourceServers = $scope.extractOutgoingSMTPServers(rawServers);
    var snapshot = [];
    for(var i = 0; i < sourceServers.length; i++) {
      var server = $scope.normalizeOutgoingSMTPServer(sourceServers[i]);
      var hasAnyValue = server.name.length > 0 ||
        server.host.length > 0 ||
        server.port.length > 0 ||
        server.email.length > 0 ||
        server.username.length > 0 ||
        server.password.length > 0 ||
        server.mechanism !== "NONE";
      if(!hasAnyValue) {
        continue;
      }
      snapshot.push(server);
    }
    return snapshot;
  }

  $scope.validateOutgoingSMTPServers = function(rawServers) {
    var sourceServers = $scope.extractOutgoingSMTPServers(rawServers);
    var seen = {};
    for(var i = 0; i < sourceServers.length; i++) {
      var server = $scope.normalizeOutgoingSMTPServer(sourceServers[i]);
      var hasAnyValue = server.name.length > 0 ||
        server.host.length > 0 ||
        server.port.length > 0 ||
        server.email.length > 0 ||
        server.username.length > 0 ||
        server.password.length > 0 ||
        server.mechanism !== "NONE";
      if(!hasAnyValue) {
        continue;
      }
      if(server.name.length === 0 || server.host.length === 0 || server.port.length === 0) {
        return "Each outgoing SMTP server needs a name, host, and port.";
      }
      var normalizedName = server.name.toLowerCase();
      if(seen[normalizedName]) {
        return "Outgoing SMTP server names must be unique.";
      }
      seen[normalizedName] = true;
      if(server.mechanism !== "NONE" && server.username.length === 0) {
        return "Outgoing SMTP username is required when authentication is enabled.";
      }
    }
    return "";
  }

  $scope.copyOutgoingSMTPServers = function(rawServers) {
    var sourceServers = $scope.sanitizeOutgoingSMTPServers(rawServers);
    var copy = [];
    for(var i = 0; i < sourceServers.length; i++) {
      copy.push(angular.extend($scope.newOutgoingSMTPServer(), sourceServers[i]));
    }
    return copy;
  }

  $scope.toOutgoingSMTPPayload = function(rawServers) {
    var sourceServers = $scope.sanitizeOutgoingSMTPServers(rawServers);
    var payload = [];
    for(var i = 0; i < sourceServers.length; i++) {
      var server = sourceServers[i];
      payload.push({
        Name: server.name,
        Email: server.email,
        Host: server.host,
        Port: server.port,
        Username: server.mechanism === "NONE" ? "" : server.username,
        Password: server.mechanism === "NONE" ? "" : server.password,
        Mechanism: server.mechanism
      });
    }
    return payload;
  }

  $scope.applyConfiguredOutgoingSMTP = function(rawServers) {
    var sourceServers = $scope.sanitizeOutgoingSMTPServers(rawServers);
    var nextMap = {};
    var nextNames = [];
    for(var i = 0; i < sourceServers.length; i++) {
      var server = sourceServers[i];
      nextMap[server.name] = {
        Name: server.name,
        Email: server.email,
        Host: server.host,
        Port: server.port,
        Username: server.username,
        Password: server.password,
        Mechanism: server.mechanism
      };
      nextNames.push(server.name);
    }
    $scope.configuredOutgoingSMTP = nextMap;
    $scope.configuredOutgoingSMTPNames = nextNames;
    if(!$scope.selectedOutgoingSMTP || !nextMap[$scope.selectedOutgoingSMTP]) {
      $scope.selectedOutgoingSMTP = nextNames.length > 0 ? nextNames[0] : "";
    }
  }

  $scope.hasConfiguredOutgoingSMTP = function() {
    return $scope.configuredOutgoingSMTPNames.length > 0;
  }

  $scope.addOutgoingSMTPServer = function() {
    if(!$scope.settingsForm.outgoingSMTP) {
      $scope.settingsForm.outgoingSMTP = [];
    }
    $scope.settingsForm.outgoingSMTP.push($scope.newOutgoingSMTPServer());
  }

  $scope.removeOutgoingSMTPServer = function(index) {
    if(!$scope.settingsForm.outgoingSMTP || index < 0 || index >= $scope.settingsForm.outgoingSMTP.length) {
      return;
    }
    $scope.settingsForm.outgoingSMTP.splice(index, 1);
  }

  $scope.clearOutgoingSMTPTestResult = function(server) {
    if(!server) {
      return;
    }
    server.testing = false;
    server.testStatus = "";
    server.testMessage = "";
    server.testError = "";
  }

  $scope.canTestOutgoingSMTPServer = function(server) {
    if(!server) {
      return false;
    }
    var normalized = $scope.normalizeOutgoingSMTPServer(server);
    if(normalized.host.length === 0 || normalized.port.length === 0) {
      return false;
    }
    if(normalized.mechanism !== "NONE" && normalized.username.length === 0) {
      return false;
    }
    return true;
  }

  $scope.outgoingSMTPTestPayload = function(server) {
    var normalized = $scope.normalizeOutgoingSMTPServer(server);
    return {
      Name: normalized.name,
      Host: normalized.host,
      Port: normalized.port,
      Username: normalized.mechanism === "NONE" ? "" : normalized.username,
      Password: normalized.mechanism === "NONE" ? "" : normalized.password,
      Mechanism: normalized.mechanism
    };
  }

  $scope.extractAPIErrorMessage = function(err, fallbackMessage) {
    if(typeof err === "string" && err.length > 0) {
      return err;
    }
    if(err && typeof err.error === "string" && err.error.length > 0) {
      return err.error;
    }
    if(err && typeof err.message === "string" && err.message.length > 0) {
      return err.message;
    }
    return fallbackMessage;
  }

  $scope.testOutgoingSMTPServer = function(server) {
    if(!server || server.testing || !$scope.canTestOutgoingSMTPServer(server)) {
      return;
    }

    server.testing = true;
    server.testStatus = "testing";
    server.testMessage = "Testing SMTP connection...";
    server.testError = "";

    $http({
      method: 'POST',
      url: $scope.host + 'api/v2/outgoing-smtp/test',
      data: $scope.outgoingSMTPTestPayload(server),
      timeout: 20000
    }).success(function(data) {
      server.testing = false;
      server.testStatus = "success";
      server.testMessage = (data && data.message) ? data.message : "SMTP server test succeeded.";
      server.testError = "";
    }).error(function(err, status) {
      server.testing = false;
      server.testStatus = "error";
      server.testMessage = "SMTP server test failed.";
      server.testError = status === -1 ? "SMTP server test timed out." : $scope.extractAPIErrorMessage(err, "Unable to complete SMTP server test.");
    });
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
      forceDefaultInboxOnly: !!$scope.settingsForm.forceDefaultInboxOnly,
      outgoingSMTP: $scope.outgoingSMTPSnapshot($scope.settingsForm.outgoingSMTP || [])
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
      var loadedOutgoingSMTP = $scope.sanitizeOutgoingSMTPServers(data.outgoingSMTP || []);
      $scope.settingsForm.retentionDays = data.retentionDays || 10;
      $scope.settingsForm.storageType = data.storageType || "maildir";
      $scope.settingsForm.maildirPath = data.maildirPath || "";
      $scope.settingsForm.defaultFolders = $scope.sanitizeDefaultFolders(data.defaultFolders || []);
      $scope.settingsForm.forceDefaultInboxOnly = data.forceDefaultInboxOnly === true;
      $scope.settingsForm.outgoingSMTP = $scope.copyOutgoingSMTPServers(loadedOutgoingSMTP);
      $scope.applyConfiguredOutgoingSMTP(loadedOutgoingSMTP);
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
    $scope.showLogs = false;
    $scope.buildConnectionSettings();
    $scope.fetchSettings();
  }

  $scope.openLogs = function() {
    $scope.preview = null;
    $scope.selectedMessageID = null;
    $scope.searching = false;
    $scope.showSettings = false;
    $scope.showLogs = true;
    $scope.refreshLogs();
  }

  $scope.refreshLogs = function() {
    $scope.logsLoading = true;
    $scope.logsError = "";

    var limit = parseInt($scope.logLinesLimit, 10);
    if(!limit || limit <= 0) {
      limit = 250;
    }
    if(limit > 2000) {
      limit = 2000;
    }
    $scope.logLinesLimit = limit;

    var url = $scope.host + 'api/v2/logs?lines=' + encodeURIComponent(limit);
    var query = ($scope.logQuery || "").trim();
    if(query.length > 0) {
      url += '&query=' + encodeURIComponent(query);
    }

    $http.get(url).success(function(data) {
      $scope.logs = data.lines || [];
      $scope.logFilePath = data.path || "";
      $scope.logsLoading = false;
    }).error(function(resp) {
      $scope.logs = [];
      $scope.logFilePath = "";
      $scope.logsLoading = false;
      if(resp && resp.error) {
        $scope.logsError = resp.error;
      } else {
        $scope.logsError = "Unable to load logs.";
      }
    });
  }

  $scope.requestClearLogs = function() {
    if($scope.logsClearing || $scope.logsLoading) {
      return;
    }
    $('#confirm-clear-logs').modal('show');
  }

  $scope.confirmClearLogs = function() {
    if($scope.logsClearing || $scope.logsLoading) {
      return;
    }
    $('#confirm-clear-logs').modal('hide');
    $scope.logsClearing = true;
    $scope.logsError = "";
    $http.delete($scope.host + 'api/v2/logs').success(function(data) {
      $scope.logs = [];
      $scope.logFilePath = data.path || "";
      $scope.logsClearing = false;
      $scope.refreshLogs();
    }).error(function(resp) {
      $scope.logsClearing = false;
      if(resp && resp.error) {
        $scope.logsError = resp.error;
      } else {
        $scope.logsError = "Unable to clear logs.";
      }
    });
  }

  $scope.onLogsAutoRefreshChanged = function() {
    if($scope.showLogs && $scope.logsAutoRefreshEnabled && !$scope.logsLoading && !$scope.logsClearing) {
      $scope.refreshLogs();
    }
  }

  logsAutoRefreshTimer = $interval(function() {
    if(!$scope.showLogs || !$scope.logsAutoRefreshEnabled || $scope.logsLoading || $scope.logsClearing) {
      return;
    }
    $scope.refreshLogs();
  }, 5000);

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
    var outgoingSMTPValidationError = $scope.validateOutgoingSMTPServers($scope.settingsForm.outgoingSMTP || []);
    if(outgoingSMTPValidationError) {
      $scope.settingsError = outgoingSMTPValidationError;
      $scope.settingsStatus = "";
      return;
    }
    var defaultFolders = $scope.sanitizeDefaultFolders($scope.settingsForm.defaultFolders);
    var outgoingSMTPPayload = $scope.toOutgoingSMTPPayload($scope.settingsForm.outgoingSMTP || []);

    $scope.settingsSaving = true;
    $scope.settingsError = "";
    $scope.settingsStatus = "";
    $http.put($scope.host + 'api/v2/settings', {
      retentionDays: retentionDays,
      storageType: $scope.settingsForm.storageType,
      defaultFolders: defaultFolders,
      forceDefaultInboxOnly: !!$scope.settingsForm.forceDefaultInboxOnly,
      outgoingSMTP: outgoingSMTPPayload
    }).success(function(data) {
      var savedOutgoingSMTP = $scope.sanitizeOutgoingSMTPServers(data.outgoingSMTP || outgoingSMTPPayload);
      $scope.settingsForm.retentionDays = data.retentionDays || retentionDays;
      $scope.settingsForm.storageType = data.storageType || $scope.settingsForm.storageType;
      $scope.settingsForm.maildirPath = data.maildirPath || $scope.settingsForm.maildirPath;
      $scope.settingsForm.defaultFolders = $scope.sanitizeDefaultFolders(data.defaultFolders || defaultFolders);
      $scope.settingsForm.forceDefaultInboxOnly = data.forceDefaultInboxOnly === true;
      $scope.settingsForm.outgoingSMTP = $scope.copyOutgoingSMTPServers(savedOutgoingSMTP);
      $scope.applyConfiguredOutgoingSMTP(savedOutgoingSMTP);
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
    $scope.showLogs = false;
    $scope.previewLoading = false;
    $scope.searching = false;
    $scope.startIndex = 0;
    $scope.refresh();
  }
  $scope.closePreview = function() {
    $scope.preview = null;
    $scope.previewLoading = false;
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
        $scope.markLastArrivalFolder(messageFolder);
        $scope.bumpFolderCount(messageFolder);
        $scope.trackMessageFolder(message);
        if(!$scope.isMessageRead(message) && $scope.messageMatchesSelectedTag(message)) {
          $scope.addToFolderUnreadCount(messageFolder, 1);
        }
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
    tabContent.css('height', '');
    tabContent.find('.tab-pane').css('height', '');
  }

  $scope.scrollSelectedMessageIntoView = function() {
    var visibleList = $('.mail-list-pane .messages:visible');
    if(visibleList.length === 0) {
      return;
    }
    var container = visibleList[0];
    var selected = visibleList.find('.msglist-message.selected');
    if(selected.length === 0) {
      return;
    }

    var selectedNode = selected[0];
    var selectedTop = selectedNode.offsetTop;
    var selectedBottom = selectedTop + selectedNode.offsetHeight;
    var viewTop = container.scrollTop;
    var viewBottom = viewTop + container.clientHeight;

    if(selectedTop < viewTop) {
      container.scrollTop = selectedTop;
      return;
    }
    if(selectedBottom > viewBottom) {
      container.scrollTop = selectedBottom - container.clientHeight;
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
    $scope.mailboxLoading = true;
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
    if($scope.selectedTag && $scope.selectedTag.length > 0) {
      url += "&tag=" + encodeURIComponent($scope.selectedTag);
    }
    url += "&order=" + encodeURIComponent($scope.sortOrder);
    $http.get(url).success(function(data) {
      $scope.messages = data.items || [];
      for(var messageIndex = 0; messageIndex < $scope.messages.length; messageIndex++) {
        $scope.trackMessageFolder($scope.messages[messageIndex]);
      }
      $scope.totalMessages = data.total;
      $scope.countMessages = data.count;
      $scope.startMessages = data.start;
      $scope.pruneFavoriteStateForDeletedMessages();

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
      $scope.mailboxLoading = false;
      $scope.listPaneLoading = false;
      $scope.previewLoading = false;
      e.done();
    }).error(function() {
      $scope.mailboxLoading = false;
      $scope.listPaneLoading = false;
      $scope.previewLoading = false;
      e.fail();
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
    $scope.showLogs = false;
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
    $scope.mailboxLoading = true;
    var url = $scope.host + 'api/v2/search?kind=' + $scope.searchKind + '&query=' + $scope.searchedText;
    if($scope.startIndex > 0) {
      url += "&start=" + $scope.startIndex;
    }
    url += "&limit=" + $scope.itemsPerPage;
    url += "&order=" + encodeURIComponent($scope.sortOrder);
    if($scope.selectedFolder && $scope.selectedFolder.length > 0) {
      url += "&folder=" + encodeURIComponent($scope.selectedFolder);
    }
    if($scope.selectedTag && $scope.selectedTag.length > 0) {
      url += "&tag=" + encodeURIComponent($scope.selectedTag);
    }
    $http.get(url).success(function(data) {
      $scope.searchMessages = data.items;
      for(var searchMessageIndex = 0; searchMessageIndex < $scope.searchMessages.length; searchMessageIndex++) {
        $scope.trackMessageFolder($scope.searchMessages[searchMessageIndex]);
      }
      $scope.totalSearchMessages = data.total;
      $scope.countSearchMessages = data.count;
      $scope.startSearchMessages = data.start;
      $scope.pruneFavoriteStateForDeletedMessages();
      $scope.syncSelectionWithVisibleMessages();
      $scope.mailboxLoading = false;
      if(!$scope.preview) {
        $scope.previewLoading = false;
      }
    }).error(function() {
      $scope.mailboxLoading = false;
      $scope.previewLoading = false;
    });
  }

  $scope.hasSelection = function() {
    return $(".messages :checked").length > 0 ? true : false;
  }

  $scope.getAPIBase = function() {
    var apiBase = $scope.host && $scope.host.length > 0 ? $scope.host : (location.protocol + '//' + location.hostname + (location.port ? ':' + location.port : '') + location.pathname);
    if(apiBase.charAt(apiBase.length - 1) !== '/') {
      apiBase += '/';
    }
    return apiBase;
  }

  $scope.getMessageCidMap = function(message, absoluteURLs) {
    var cidMap = {};
    if(!message || !message.ID || !message.MIME || !message.MIME.Parts || !message.MIME.Parts.length) {
      return cidMap;
    }
    var apiBase = absoluteURLs ? $scope.getAPIBase() : "";
    for(var p in message.MIME.Parts) {
      for(var h in message.MIME.Parts[p].Headers) {
        if(h.toLowerCase() == "content-id") {
          var cid = message.MIME.Parts[p].Headers[h][0]
          cid = cid.substr(1,cid.length-2)
          cidMap[cid] = apiBase + "api/v1/messages/" + message.ID + "/mime/part/" + p + "/download"
        }
      }
    }
    return cidMap;
  }

  $scope.applyCidMapToHTML = function(html, cidMap) {
    var output = html || "";
    if(!cidMap) {
      return output;
    }
    for(var c in cidMap) {
      var str = "cid:" + c;
      var pat = str.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, "\\$1");
      output = output.replace(new RegExp(pat, 'g'), cidMap[c]);
    }
    return output;
  }

  $scope.buildMessagePreviewHTML = function(message, absoluteURLs) {
    var html = $scope.getMessageHTML(message);
    var cidMap = $scope.getMessageCidMap(message, absoluteURLs);
    return $scope.applyCidMapToHTML(html, cidMap);
  }

  $scope.renderMessageInNewWindow = function(targetWindow, message) {
    if(!targetWindow) {
      return;
    }

    var subject = "";
    if(message && message.Content && message.Content.Headers && message.Content.Headers["Subject"] && message.Content.Headers["Subject"][0]) {
      subject = $scope.tryDecodeMime(message.Content.Headers["Subject"][0]);
    }
    if(!subject || subject.length === 0) {
      subject = "Email preview";
    }

    var content = "";
    if(message && $scope.hasHTML(message)) {
      content = $scope.buildMessagePreviewHTML(message, true);
    } else {
      var plain = message ? ($scope.getMessagePlain(message) || "") : "";
      content = "<div style=\"padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;\"><pre style=\"white-space:pre-wrap;word-break:break-word;border:1px solid #e0e4eb;border-radius:8px;padding:14px;background:#ffffff;color:#202124;\">" + $scope.escapeHtml(plain) + "</pre></div>";
    }

    targetWindow.document.open();
    targetWindow.document.write('<!doctype html><html><head><meta charset="utf-8"><title>' + $scope.escapeHtml(subject) + '</title><style>html,body{margin:0;padding:0;background:#fff;color:#202124;}img{max-width:100%;height:auto;}table{max-width:100%;}</style></head><body>' + content + '</body></html>');
    targetWindow.document.close();
  }

  $scope.openMessageFullView = function(message, $event) {
    if($event) {
      $event.preventDefault();
      $event.stopPropagation();
    }
    if(!message || !message.ID) {
      return;
    }

    var previewWindow = window.open("", "_blank");
    if(!previewWindow) {
      return;
    }

    previewWindow.document.open();
    previewWindow.document.write("<!doctype html><html><head><meta charset=\"utf-8\"><title>Email preview</title></head><body style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;padding:24px;color:#5f6368;\">Loading email preview...</body></html>");
    previewWindow.document.close();

    if($scope.cache[message.ID]) {
      $scope.renderMessageInNewWindow(previewWindow, $scope.cache[message.ID]);
      return;
    }

    $http.get($scope.host + 'api/v1/messages/' + message.ID).success(function(data) {
      $scope.cache[message.ID] = data;
      $scope.renderMessageInNewWindow(previewWindow, data);
    }).error(function() {
      $scope.renderMessageInNewWindow(previewWindow, message);
    });
  }

  $scope.prepareMessageForPreview = function(message) {
    if(!message || message.$previewPrepared) {
      return message;
    }
    message.$cidMap = $scope.getMessageCidMap(message, false);
    message.previewHTML = $sce.trustAsHtml($scope.buildMessagePreviewHTML(message, false));
    message.$previewPrepared = true;
    return message;
  }

  $scope.selectMessage = function(message) {
    if(!message || !message.ID) {
      return;
    }
    $scope.showSettings = false;
    $scope.showLogs = false;
    $scope.selectedMessageID = message.ID;
    $scope.setMessageReadStateByID(message.ID, true, message);
    $scope.clearLastArrivalIndicatorForMessage(message);
    $scope.rememberSelectedMessageForCurrentFolder(message.ID);
    $timeout(function(){
      $scope.resizePreview();
      $scope.scrollSelectedMessageIntoView();
    }, 0);

    // Cancel any previous delayed preview loading state when changing selection.
    if($scope.previewLoadingTimerPromise) {
      $timeout.cancel($scope.previewLoadingTimerPromise);
      $scope.previewLoadingTimerPromise = null;
    }
    $scope.previewLoading = false;

    if($scope.cache[message.ID]) {
      $scope.preview = $scope.prepareMessageForPreview($scope.cache[message.ID]);
      $scope.loadEmailQuality($scope.preview);
    } else {
      // v2 list responses already include full message payload for preview in
      // normal flows, so use that immediately and avoid click-time refetch.
      if(message.Content && message.Content.Headers) {
        $scope.cache[message.ID] = message;
        $scope.preview = $scope.prepareMessageForPreview(message);
        $scope.loadEmailQuality($scope.preview);
        return;
      }

      // Fallback for partial payloads only.
      var requestedMessageID = message.ID;
      var requestSequence = ++$scope.previewRequestSequence;
      var e = null;
      $scope.previewLoadingTimerPromise = $timeout(function() {
        if($scope.selectedMessageID !== requestedMessageID || $scope.previewRequestSequence !== requestSequence) {
          return;
        }
        $scope.previewLoading = true;
        e = $scope.startEvent("Loading message", message.ID, "glyphicon-download-alt");
      }, 500);

      $http.get($scope.host + 'api/v1/messages/' + requestedMessageID).success(function(data) {
        $scope.cache[requestedMessageID] = data;
        if($scope.selectedMessageID !== requestedMessageID) {
          if(e) {
            e.done();
          }
          return;
        }
        $scope.preview = $scope.prepareMessageForPreview(data);
        $scope.loadEmailQuality($scope.preview);
        $scope.previewLoading = false;
        if(e) {
          e.done();
        }
      }).error(function() {
        if($scope.selectedMessageID === requestedMessageID) {
          $scope.previewLoading = false;
        }
        if(e) {
          e.fail();
        }
      }).finally(function() {
        if($scope.previewLoadingTimerPromise) {
          $timeout.cancel($scope.previewLoadingTimerPromise);
          $scope.previewLoadingTimerPromise = null;
        }
        if($scope.selectedMessageID === requestedMessageID) {
          $scope.previewLoading = false;
        }
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
  	return moment(timestamp).format("ddd MMM D YYYY HH:mm:ss");
  };

  $scope.deleteAll = function() {
  	$('#confirm-delete-all').modal('show');
  }

  $scope.clearPendingFolderDelete = function() {
    $scope.folderPendingDelete = "";
    $scope.folderPendingDeleteIsInbox = false;
    $scope.folderPendingDeleteIncludeFavorites = false;
  }

  $('#confirm-delete-folder').on('show.bs.modal', function() {
    $scope.$applyAsync(function() {
      $scope.folderPendingDeleteIncludeFavorites = false;
    });
  });

  $scope.performFolderDelete = function(folderName, allowInbox, includeFavorites) {
    var targetFolder = (folderName || "").trim();
    var isInboxTarget = !!allowInbox || $scope.normalizeFolderName(targetFolder).length === 0;
    var shouldDeleteFavorites = !!includeFavorites;
    if(!isInboxTarget && targetFolder.length === 0) {
      return;
    }

    var eventLabel = isInboxTarget ? "Inbox" : targetFolder;
    var eventName = isInboxTarget ? "Deleting inbox messages" : "Deleting folder messages";
    var e = $scope.startEvent(eventName, eventLabel, "glyphicon-trash");
    var idsToDelete = [];
    var fetchStart = 0;
    var fetchLimit = 250;

    var fetchMessagesToDelete = function() {
      var url = $scope.host + 'api/v2/messages?folder=' + encodeURIComponent(targetFolder) + '&start=' + fetchStart + '&limit=' + fetchLimit + '&order=desc';
      $http.get(url).success(function(data) {
        var items = (data && data.items) ? data.items : [];
        for(var i = 0; i < items.length; i++) {
          if(items[i] && items[i].ID && (shouldDeleteFavorites || !$scope.isMessageFavorite(items[i]))) {
            idsToDelete.push(items[i].ID);
          }
        }

        fetchStart += items.length;
        var total = parseInt(data && data.total, 10);
        if(isNaN(total) || total < fetchStart) {
          total = fetchStart;
        }
        if(items.length === 0 || fetchStart >= total) {
          deleteMessages();
          return;
        }
        fetchMessagesToDelete();
      }).error(function(err) {
        e.fail();
        e.error = err;
      });
    };

    var finalizeDelete = function(deletedIDs) {
      var normalizedTargetFolder = $scope.normalizeFolderName(targetFolder);
      if(!isInboxTarget && $scope.lastArrivalFolderKey === $scope.normalizeFolderName(targetFolder)) {
        $scope.lastArrivalFolderKey = null;
      }
      for(var deletedIndex = 0; deletedIndex < deletedIDs.length; deletedIndex++) {
        var deletedID = deletedIDs[deletedIndex];
        if(normalizedTargetFolder.length > 0 && $scope.messageFolderByID[deletedID] === normalizedTargetFolder) {
          delete $scope.messageFolderByID[deletedID];
        }
        $scope.forgetRememberedMessageID(deletedID);
        delete $scope.favoriteStateByMessageID[deletedID];
        delete $scope.readStateByMessageID[deletedID];
        delete $scope.attachmentCacheByMessageID[deletedID];
        delete $scope.qualityCacheByMessageID[deletedID];
      }
      $scope.persistFavoriteState();
      $scope.persistReadState();
      if(normalizedTargetFolder.length > 0) {
        delete $scope.folderUnreadCounts[normalizedTargetFolder];
      }
      delete $scope.lastSelectedMessageByFolder[$scope.getFolderSelectionKey(targetFolder)];
      $scope.preview = null;
      $scope.selectedMessageID = null;
      $scope.startIndex = 0;
      $scope.startMessages = 0;
      $scope.searching = false;
      $scope.refresh();
      e.done();
    };

    var deleteMessages = function() {
      if(idsToDelete.length === 0) {
        finalizeDelete([]);
        return;
      }

      var deletedIDs = [];
      var deleteAt = 0;
      var deleteNext = function() {
        if(deleteAt >= idsToDelete.length) {
          finalizeDelete(deletedIDs);
          return;
        }

        var id = idsToDelete[deleteAt];
        $http.delete($scope.host + 'api/v1/messages/' + id).success(function() {
          deletedIDs.push(id);
          deleteAt++;
          deleteNext();
        }).error(function(err) {
          e.fail();
          e.error = err;
        });
      };

      deleteNext();
    };

    fetchMessagesToDelete();
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
    $scope.folderPendingDeleteIncludeFavorites = false;
    $('#confirm-delete-folder').modal('show');
  }

  $scope.deleteInboxMessages = function($event) {
    if($event) {
      $event.preventDefault();
      $event.stopPropagation();
    }
    $scope.folderPendingDelete = "";
    $scope.folderPendingDeleteIsInbox = true;
    $scope.folderPendingDeleteIncludeFavorites = false;
    $('#confirm-delete-folder').modal('show');
  }

  $scope.deleteFolderConfirm = function() {
    $('#confirm-delete-folder').modal('hide');
    var folderName = $scope.folderPendingDelete;
    var deleteInboxMessages = $scope.folderPendingDeleteIsInbox;
    var includeFavorites = $scope.folderPendingDeleteIncludeFavorites;
    $scope.clearPendingFolderDelete();
    $scope.performFolderDelete(folderName, deleteInboxMessages, includeFavorites);
  }

  $scope.onReleaseServerChanged = function() {
    if(!$scope.selectedOutgoingSMTP || !$scope.configuredOutgoingSMTP[$scope.selectedOutgoingSMTP]) {
      $scope.releaseEmailAddress = $scope.getSavedReleaseEmailForServer("");
      return;
    }
    var savedEmail = $scope.getSavedReleaseEmailForServer($scope.selectedOutgoingSMTP);
    if(savedEmail.length > 0) {
      $scope.releaseEmailAddress = savedEmail;
      return;
    }
    $scope.releaseEmailAddress = $scope.configuredOutgoingSMTP[$scope.selectedOutgoingSMTP].Email || "";
  }

  $scope.releaseOne = function(message) {
    if(!$scope.hasConfiguredOutgoingSMTP()) {
      return;
    }
    $scope.releasing = message;
    if(!$scope.selectedOutgoingSMTP || !$scope.configuredOutgoingSMTP[$scope.selectedOutgoingSMTP]) {
      $scope.selectedOutgoingSMTP = $scope.configuredOutgoingSMTPNames.length > 0 ? $scope.configuredOutgoingSMTPNames[0] : "";
    }
    $scope.onReleaseServerChanged();
    $('#release-one').modal('show');
  }

  $scope.canConfirmReleaseMessage = function() {
    var selectedServer = ($scope.selectedOutgoingSMTP || "").trim();
    var targetEmail = ($scope.releaseEmailAddress || "").trim();
    return selectedServer.length > 0 && targetEmail.length > 0;
  }

  $scope.confirmReleaseMessage = function() {
    if(!$scope.releasing || !$scope.releasing.ID) {
      return;
    }
    if(!$scope.canConfirmReleaseMessage()) {
      return;
    }
    var selectedServer = ($scope.selectedOutgoingSMTP || "").trim();
    var targetEmail = ($scope.releaseEmailAddress || "").trim();
    $scope.rememberReleaseEmail(selectedServer, targetEmail);

    $('#release-one').modal('hide');
    var message = $scope.releasing;
    $scope.releasing = null;
    $scope.releaseEmailAddress = "";

    var e = $scope.startEvent("Releasing message", message.ID, "glyphicon-share");

    var authcfg = {
      name: selectedServer,
      email: targetEmail
    };

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
      $scope.lastArrivalFolderKey = null;
      $scope.lastSelectedMessageByFolder = {};
      $scope.restoreMessageIDOnNextRefresh = null;
      $scope.folderUnreadCounts = {};
      $scope.messageFolderByID = {};
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
      var normalizedFolderName = $scope.normalizeFolderName($scope.getFolderFromMessage(message));
      if(normalizedFolderName.length === 0 && $scope.messageFolderByID[message.ID]) {
        normalizedFolderName = $scope.messageFolderByID[message.ID];
      }
      if(normalizedFolderName.length > 0 && !$scope.readStateByMessageID[message.ID]) {
        $scope.addToFolderUnreadCount(normalizedFolderName, -1);
      }
      delete $scope.messageFolderByID[message.ID];
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
