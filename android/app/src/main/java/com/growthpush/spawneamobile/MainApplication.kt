package com.growthpush.spawneamobile

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.growthpush.spawneamobile.network.SpawneaHttpPackage
import com.growthpush.spawneamobile.security.SpawneaKeystorePackage

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    val hasBundledJs =
      applicationContext.assets.list("")?.contains("index.android.bundle") == true
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here, for example:
          add(SpawneaHttpPackage())
          add(SpawneaKeystorePackage())
        },
      useDevSupport = BuildConfig.DEBUG && !hasBundledJs,
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
