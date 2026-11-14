package com.growthpush.spawneamobile

import org.junit.Assert.assertEquals
import org.junit.Test

class MainActivityTest {
  @Test
  fun usesFlagSecureBelowApi33AndRecentsApiOn33Plus() {
    for (sdkInt in 24..32) {
      var recentsCalls = 0
      var secureCalls = 0
      MainActivity.applyRecentsProtection(
          sdkInt = sdkInt,
          disableRecentsScreenshot = { recentsCalls += 1 },
          addSecureFlag = { secureCalls += 1 },
      )
      assertEquals("API $sdkInt should not invoke setRecentsScreenshotEnabled", 0, recentsCalls)
      assertEquals("API $sdkInt should set FLAG_SECURE", 1, secureCalls)
    }

    for (sdkInt in listOf(33, 34, 35, 36)) {
      var recentsCalls = 0
      var secureCalls = 0
      MainActivity.applyRecentsProtection(
          sdkInt = sdkInt,
          disableRecentsScreenshot = { recentsCalls += 1 },
          addSecureFlag = { secureCalls += 1 },
      )
      assertEquals("API $sdkInt should invoke setRecentsScreenshotEnabled(false)", 1, recentsCalls)
      assertEquals("API $sdkInt should not set FLAG_SECURE", 0, secureCalls)
    }
  }
}
